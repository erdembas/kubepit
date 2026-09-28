import {
  evaluatePod,
  isPssLevel,
  isPssVersion,
  podInputOf,
  violationText,
  type PssLevel,
} from '@/lib/kube/pss';
import type { PodSecurityDryRun, PodSecurityViolation } from '@/types';
import { mockDecide } from './access';
import { sleep } from './bus';
import { find, list, getDb } from './fixtures/db';
import { register, type MockArgs } from './registry';

/**
 * Demo `pod_security_dry_run`: plays the PodSecurity admission plugin. The
 * existing pods of the namespace are evaluated with the same checks the UI
 * uses locally and returned as the warnings the API server would send
 * (grouped per identical failure, first pod name alphabetically). Nothing
 * is changed, so read-only clusters allow it like the real command.
 */

const ENFORCE = 'pod-security.kubernetes.io/enforce';
const ENFORCE_VERSION = 'pod-security.kubernetes.io/enforce-version';

function podLabel(pod: string, count: number): string {
  if (count <= 1) return pod;
  if (count === 2) return `${pod} (and 1 other pod)`;
  return `${pod} (and ${count - 1} other pods)`;
}

register({
  pod_security_dry_run: async ({ clusterId, namespace, level, version }: MockArgs) => {
    await sleep(280);
    if (!isPssLevel(level))
      throw new Error(
        `unknown Pod Security level "${level}" (expected privileged, baseline or restricted)`,
      );
    if (!isPssVersion(version))
      throw new Error(`unknown Pod Security version "${version}" (expected latest or v1.<minor>)`);
    const db = getDb(clusterId);
    const ns = find(db, 'namespaces', null, namespace);
    if (!ns)
      throw new Error(
        `failed to read namespace "${namespace}": namespaces "${namespace}" not found`,
      );
    const allowed = mockDecide(clusterId, {
      verb: 'patch',
      group: '',
      resource: 'namespaces',
      name: namespace,
      namespace: null,
    }).allowed;
    if (!allowed)
      throw new Error(
        `the dry run failed: namespaces "${namespace}" is forbidden: the current user cannot patch resource "namespaces" in API group "" at the cluster scope`,
      );
    const labels = ns.metadata.labels ?? {};
    const out: PodSecurityDryRun = {
      namespace,
      level: level as PssLevel,
      version,
      unchanged: false,
      warnings: [],
      violations: [],
      notes: [],
    };
    if (labels[ENFORCE] === level && (labels[ENFORCE_VERSION] ?? 'latest') === version)
      return { ...out, unchanged: true };

    const groups = new Map<string, { pod: string; count: number; checks: string[] }>();
    for (const pod of list(db, 'pods')) {
      if (pod.metadata.namespace !== namespace) continue;
      const input = podInputOf(pod);
      if (!input) continue;
      const failed = evaluatePod({ level: level as PssLevel, version }, input);
      if (!failed.length) continue;
      const checks = failed.map(violationText);
      const key = checks.join(', ');
      const g = groups.get(key);
      if (!g) groups.set(key, { pod: pod.metadata.name, count: 1, checks });
      else {
        g.count++;
        if (pod.metadata.name < g.pod) g.pod = pod.metadata.name;
      }
    }
    if (!groups.size) return out;
    const violations: PodSecurityViolation[] = [...groups.values()]
      .map((g) => ({ pod: g.pod, others: g.count - 1, checks: g.checks }))
      .sort((a, b) =>
        `${podLabel(a.pod, a.others + 1)}: ${a.checks.join(', ')}`.localeCompare(
          `${podLabel(b.pod, b.others + 1)}: ${b.checks.join(', ')}`,
        ),
      );
    return {
      ...out,
      violations,
      warnings: [
        `existing pods in namespace "${namespace}" violate the new PodSecurity enforce level "${level}:${version}"`,
        ...violations.map((v) => `${podLabel(v.pod, v.others + 1)}: ${v.checks.join(', ')}`),
      ],
    };
  },
});
