import type { KubeObject } from '@/types';
import { podSpecFindings } from './containers';
import { collectReferences, unusedConfigFindings, unusedSecretFindings } from './config';
import {
  certManagerFindings,
  isCertManagerCertificate,
  secretCertificateFindings,
} from './certificates';
import { FindingSink, nsKey, specOwners, type Emit } from './context';
import { nodeFindings } from './nodes';
import { ingressFindings, serviceFindings } from './network';
import { podStatusFindings } from './pods';
import { hpaFindings, pdbCoverageFindings, pdbFindings } from './policy';
import { RULES, ruleDef } from './rules';
import { pvcFindings, unusedClaimFindings } from './storage';
import { rightsizingFindings } from './rightsizing';
import {
  CATEGORIES,
  SEVERITIES,
  type Category,
  type Finding,
  type HealthIgnore,
  type HealthInput,
  type HealthKind,
  type HealthScan,
  type HealthSummary,
  type RuleGroup,
  type Severity,
} from './types';
import { cronJobFindings, singleReplicaFindings } from './workloads';
import { podSecurityFindings } from './podSecurity';
import { rbacFindings } from './rbac';
import { SECRET_REFERRERS } from './secretRefs';

/**
 * Runs every rule family over a `HealthInput`. The scan is split into
 * passes so the async runner can yield between them and keep the UI
 * responsive on large clusters; the result is identical either way.
 */

/** Objects evaluated per list; beyond it a list is truncated (and reported). */
export const MAX_OBJECTS_PER_KIND = 20_000;

type Pass = (input: HealthInput, emit: Emit) => void;

const needsMet = (input: HealthInput, ruleId: string) =>
  (ruleDef(ruleId)?.needs ?? []).every((k) => input.loaded.has(k));

const PASSES: Pass[] = [
  (input, emit) => {
    for (const owner of specOwners(input)) podSpecFindings(owner, emit);
  },
  (input, emit) => {
    for (const pod of input.pods) podStatusFindings(pod, input.now, emit);
  },
  (input, emit) => {
    if (needsMet(input, 'workload-single-replica')) singleReplicaFindings(input, emit);
    if (needsMet(input, 'cronjob-last-failed')) cronJobFindings(input, emit);
    rightsizingFindings(input, emit);
  },
  (input, emit) => {
    if (input.loaded.has('pods')) serviceFindings(input, emit);
    ingressFindings(input, emit);
  },
  (input, emit) => {
    const refs = collectReferences(input);
    if (needsMet(input, 'configmap-unused')) unusedConfigFindings(input, refs, emit);
    if (needsMet(input, 'secret-unused')) unusedSecretFindings(input, refs, emit);
    if (needsMet(input, 'pvc-unused')) unusedClaimFindings(input, refs, emit);
  },
  (input, emit) => {
    for (const pvc of input.pvcs) pvcFindings(pvc, input.now, emit);
    for (const pdb of input.pdbs) pdbFindings(pdb, emit);
    if (needsMet(input, 'pdb-no-pods')) pdbCoverageFindings(input, emit);
    if (needsMet(input, 'hpa-missing-target')) hpaFindings(input, emit);
  },
  (input, emit) => {
    for (const node of input.nodes) nodeFindings(node, emit);
  },
  (input, emit) => {
    for (const secret of input.secrets) secretCertificateFindings(secret, input.now, emit);
    const secrets = new Set(input.secrets.map((s) => nsKey(s.metadata.namespace, s.metadata.name)));
    const inspected = input.loaded.has('secrets');
    for (const cert of input.certificates) {
      const secretName = String(cert.spec?.secretName ?? '');
      const withExpiry = !inspected || !secrets.has(nsKey(cert.metadata.namespace, secretName));
      certManagerFindings(cert, input.now, withExpiry, emit);
    }
  },
  // Security: Pod Security Standards per namespace, risky RBAC grants.
  (input, emit) => podSecurityFindings(input, emit),
  (input, emit) => rbacFindings(input, emit),
];

const KIND_LISTS: HealthKind[] = [
  'pods',
  'deployments',
  'statefulSets',
  'daemonSets',
  'jobs',
  'cronJobs',
  'services',
  'ingresses',
  'configMaps',
  'secrets',
  'pvcs',
  'pdbs',
  'hpas',
  'nodes',
  'certificates',
  'roleBindings',
  'clusterRoleBindings',
];

/** Lists rules read for context only (their objects get no findings of their own). */
const CONTEXT_LISTS: HealthKind[] = [
  'serviceAccounts',
  'namespaces',
  'roles',
  'clusterRoles',
  ...SECRET_REFERRERS,
];

function capped(input: HealthInput): { input: HealthInput; truncated: HealthKind[] } {
  const truncated: HealthKind[] = [];
  const next = { ...input };
  for (const kind of [...KIND_LISTS, ...CONTEXT_LISTS]) {
    if (input[kind].length > MAX_OBJECTS_PER_KIND) {
      next[kind] = input[kind].slice(0, MAX_OBJECTS_PER_KIND);
      truncated.push(kind);
    }
  }
  return { input: next, truncated };
}

function finish(input: HealthInput, sink: FindingSink, truncated: HealthKind[]): HealthScan {
  const scanned = new Map<string, number>();
  for (const kind of KIND_LISTS) {
    const items = input[kind];
    if (!items.length) continue;
    const k = items[0]!.kind;
    scanned.set(k, (scanned.get(k) ?? 0) + items.length);
  }
  const skippedKinds = KIND_LISTS.filter((k) => !input.loaded.has(k) && k !== 'certificates');
  return {
    findings: sink.findings,
    scanned,
    overflow: sink.overflow,
    skippedKinds: [...new Set([...skippedKinds, ...truncated])],
    computedAt: input.now,
  };
}

/** Synchronous scan (small inputs, tests). */
export function scanHealth(raw: HealthInput): HealthScan {
  const { input, truncated } = capped(raw);
  const sink = new FindingSink();
  for (const pass of PASSES) pass(input, sink.emit);
  return finish(input, sink, truncated);
}

/** The same scan, yielding to the event loop between passes. Rejects with `AbortError`. */
export async function scanHealthAsync(raw: HealthInput, signal?: AbortSignal): Promise<HealthScan> {
  const { input, truncated } = capped(raw);
  const sink = new FindingSink();
  for (const pass of PASSES) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
    pass(input, sink.emit);
  }
  return finish(input, sink, truncated);
}

// ---------------------------------------------------------------------------
// Ignores, score and grouping
// ---------------------------------------------------------------------------

export function isIgnored(f: Pick<Finding, 'ruleId' | 'ref'>, ignores: readonly HealthIgnore[]) {
  return ignores.some(
    (i) => i.rule === f.ruleId && (i.namespace === null || i.namespace === f.ref.namespace),
  );
}

/** An opt-in rule the cluster has not turned on. */
function isOffByDefault(f: Pick<Finding, 'ruleId'>, optIns: readonly string[]) {
  return ruleDef(f.ruleId)?.optIn === true && !optIns.includes(f.ruleId);
}

/**
 * Hidden from the view, counts and score: ignored, or produced by an opt-in
 * rule the cluster has not turned on (`optIns`: the rule ids turned on).
 */
export function isSilenced(
  f: Pick<Finding, 'ruleId' | 'ref'>,
  ignores: readonly HealthIgnore[],
  optIns: readonly string[],
) {
  return isIgnored(f, ignores) || isOffByDefault(f, optIns);
}

const PENALTY: Record<Severity, number> = { critical: 100, warning: 50, info: 10 };
const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function severityRank(s: Severity) {
  return RANK[s];
}

export function gradeOf(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  if (score >= 50) return 'E';
  return 'F';
}

/**
 * Drops silenced findings (`isSilenced`) and computes the score (mean over
 * kinds of the per-object scores). `ignored` counts explicit ignores only, not
 * the findings of opt-in rules that are off.
 */
export function summarize(
  scan: HealthScan,
  ignores: readonly HealthIgnore[],
  optIns: readonly string[] = [],
): HealthSummary {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const byUid = new Map<string, Finding[]>();
  const groups = new Map<string, RuleGroup>();
  const worst = new Map<string, { kind: string; penalty: number }>();
  let ignored = 0;
  for (const f of scan.findings) {
    if (isSilenced(f, ignores, optIns)) {
      if (!isOffByDefault(f, optIns)) ignored++;
      continue;
    }
    counts[f.severity]++;
    categories[f.category]++;
    const list = byUid.get(f.ref.uid);
    if (list) list.push(f);
    else byUid.set(f.ref.uid, [f]);
    let g = groups.get(f.ruleId);
    if (!g) {
      const def = ruleDef(f.ruleId);
      g = {
        ruleId: f.ruleId,
        severity: f.severity,
        category: def?.category ?? f.category,
        findings: [],
        total: scan.overflow.get(f.ruleId) ?? 0,
      };
      groups.set(f.ruleId, g);
    }
    g.findings.push(f);
    g.total++;
    if (RANK[f.severity] < RANK[g.severity]) g.severity = f.severity;
    const w = worst.get(f.ref.uid);
    const p = PENALTY[f.severity];
    if (!w || p > w.penalty) worst.set(f.ref.uid, { kind: f.ref.kind, penalty: p });
  }
  const penalties = new Map<string, number>();
  for (const { kind, penalty } of worst.values())
    penalties.set(kind, (penalties.get(kind) ?? 0) + penalty);
  const kindScores: number[] = [];
  for (const [kind, total] of scan.scanned) {
    if (!total) continue;
    kindScores.push(Math.max(0, 100 - (penalties.get(kind) ?? 0) / total));
  }
  const score = kindScores.length
    ? Math.round(kindScores.reduce((a, b) => a + b, 0) / kindScores.length)
    : 100;
  const order = new Map(RULES.map((r, i) => [r.id, i]));
  return {
    score,
    grade: gradeOf(score),
    counts,
    categories,
    byUid,
    ignored,
    groups: [...groups.values()].sort(
      (a, b) =>
        RANK[a.severity] - RANK[b.severity] ||
        (order.get(a.ruleId) ?? 0) - (order.get(b.ruleId) ?? 0),
    ),
  };
}

// ---------------------------------------------------------------------------
// One object (details panel)
// ---------------------------------------------------------------------------

/** Findings of the rules that only need the object itself. */
export function objectFindings(obj: KubeObject, now = Date.now()): Finding[] {
  const sink = new FindingSink();
  const emit = sink.emit;
  switch (obj.kind) {
    case 'Pod':
      podSpecFindings(obj, emit);
      podStatusFindings(obj, now, emit);
      break;
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
    case 'CronJob':
      podSpecFindings(obj, emit);
      break;
    case 'Node':
      nodeFindings(obj, emit);
      break;
    case 'PersistentVolumeClaim':
      pvcFindings(obj, now, emit);
      break;
    case 'PodDisruptionBudget':
      pdbFindings(obj, emit);
      break;
    case 'Secret':
      secretCertificateFindings(obj, now, emit);
      break;
    default:
      if (isCertManagerCertificate(obj)) certManagerFindings(obj, now, true, emit);
  }
  return sink.findings;
}

/**
 * Local findings merged with the cross-object findings a scan attached to
 * the same uid, most severe first.
 */
export function mergeFindings(
  local: Finding[],
  scanned: readonly Finding[] | undefined,
): Finding[] {
  const ids = new Set(local.map((f) => f.id));
  // Object-local rules were just re-evaluated on the live object; only add cross-object ones.
  const cross = (scanned ?? []).filter((f) => !ids.has(f.id) && !ruleDef(f.ruleId)?.local);
  return [...local, ...cross].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
