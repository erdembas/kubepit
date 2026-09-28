import * as i18n from '@/i18n/core';
import { SECURITY_RULES } from './securityRules';
import type { Category, HealthKind, Severity } from './types';

/**
 * Rule catalog: stable ids (persisted in ignores), default severity,
 * category and the lists a rule needs. Titles and fix hints are translated
 * lazily so the view follows the UI language.
 */

export interface RuleDef {
  id: string;
  category: Category;
  severity: Severity;
  /** Lists that must be loaded for the rule to run without false positives. */
  needs: readonly HealthKind[];
  /** Object-local rules can be evaluated from one object (details panel). */
  local: boolean;
  /**
   * Off by default: findings are computed but silenced (`isSilenced`) unless
   * the cluster turned the rule on (`healthOptIns` in the workspace).
   */
  optIn: boolean;
  title: () => string;
  hint: () => string;
}

const WORKLOADS: HealthKind[] = ['deployments', 'statefulSets', 'daemonSets', 'jobs', 'cronJobs'];

function rule(
  id: string,
  category: Category,
  severity: Severity,
  needs: readonly HealthKind[],
  local: boolean,
  title: () => string,
  hint: () => string,
  opts: { optIn?: boolean } = {},
): RuleDef {
  return { id, category, severity, needs, local, optIn: opts.optIn ?? false, title, hint };
}

export const RULES: readonly RuleDef[] = [
  // -- Containers -------------------------------------------------------------
  rule(
    'container-no-requests',
    'efficiency',
    'warning',
    [],
    true,
    () => i18n.t('Containers without CPU or memory requests'),
    () =>
      i18n.t(
        'Set resources.requests so the scheduler can place pods and the node reserves capacity for them.',
      ),
  ),
  rule(
    'container-no-memory-limit',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('Containers without a memory limit'),
    () =>
      i18n.t(
        'Set resources.limits.memory so a leaking container is OOM-killed instead of starving its node.',
      ),
  ),
  rule(
    'container-no-readiness-probe',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('Containers without a readiness probe'),
    () =>
      i18n.t(
        'Add a readinessProbe so Services only route traffic to containers that are ready to serve.',
      ),
  ),
  rule(
    'container-no-liveness-probe',
    'reliability',
    'info',
    [],
    true,
    () => i18n.t('Containers without a liveness probe'),
    () =>
      i18n.t('Add a livenessProbe so the kubelet restarts containers that hang without exiting.'),
  ),
  rule(
    'image-latest-tag',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('Images using :latest or no tag'),
    () =>
      i18n.t(
        'Pin images to an immutable version tag or digest so rollouts are reproducible and can be rolled back.',
      ),
  ),
  rule(
    'image-pull-always-digest',
    'efficiency',
    'info',
    [],
    true,
    () => i18n.t('imagePullPolicy Always with a pinned digest'),
    () =>
      i18n.t(
        'A digest never changes; use imagePullPolicy IfNotPresent to skip the registry round trip on every start.',
      ),
  ),
  // -- Security ---------------------------------------------------------------
  rule(
    'container-privileged',
    'security',
    'critical',
    [],
    true,
    () => i18n.t('Privileged containers'),
    () =>
      i18n.t(
        'Drop securityContext.privileged and grant only the Linux capabilities the container needs.',
      ),
  ),
  rule(
    'container-run-as-root',
    'security',
    'warning',
    [],
    true,
    () => i18n.t('Containers that may run as root'),
    () => i18n.t('Set securityContext.runAsNonRoot: true and a non-zero runAsUser.'),
  ),
  rule(
    'container-privilege-escalation',
    'security',
    'warning',
    [],
    true,
    () => i18n.t('Privilege escalation allowed'),
    () => i18n.t('Set securityContext.allowPrivilegeEscalation: false on every container.'),
  ),
  rule(
    'container-privilege-escalation-unset',
    'security',
    'info',
    [],
    true,
    () => i18n.t('Containers that do not disable privilege escalation'),
    () => i18n.t('Set securityContext.allowPrivilegeEscalation: false on every container.'),
    { optIn: true },
  ),
  rule(
    'pod-host-path',
    'security',
    'warning',
    [],
    true,
    () => i18n.t('hostPath volumes'),
    () =>
      i18n.t(
        'Replace hostPath volumes with PersistentVolumeClaims, ConfigMaps or emptyDir; host paths expose the node file system.',
      ),
  ),
  rule(
    'pod-host-network',
    'security',
    'warning',
    [],
    true,
    () => i18n.t('Host network, PID or IPC namespaces'),
    () =>
      i18n.t(
        'Remove hostNetwork, hostPID and hostIPC unless the workload is a node agent that really needs them.',
      ),
  ),
  // -- Workloads & pods -------------------------------------------------------
  rule(
    'workload-single-replica',
    'reliability',
    'warning',
    ['hpas'],
    false,
    () => i18n.t('Single-replica Deployments and StatefulSets'),
    () =>
      i18n.t(
        'Run at least two replicas (spread across nodes) so a node drain or crash does not cause downtime.',
      ),
  ),
  rule(
    'pod-crashloop',
    'reliability',
    'critical',
    [],
    true,
    () => i18n.t('Pods in CrashLoopBackOff'),
    () => i18n.t('Check the previous container logs and events; the process keeps exiting.'),
  ),
  rule(
    'pod-image-pull',
    'reliability',
    'critical',
    [],
    true,
    () => i18n.t('Pods that cannot pull their image'),
    () =>
      i18n.t(
        'Check the image name and tag, registry reachability and the pull secret of the service account.',
      ),
  ),
  rule(
    'pod-restarts',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('Pods with many restarts'),
    () =>
      i18n.t(
        'Look at the last termination reason (OOMKilled, error exit codes) and the previous logs.',
      ),
  ),
  rule(
    'pod-pending',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('Pods pending for too long'),
    () =>
      i18n.t(
        'Check the PodScheduled condition and events: insufficient resources, taints, affinity or unbound volumes.',
      ),
  ),
  rule(
    'cronjob-last-failed',
    'reliability',
    'warning',
    ['jobs'],
    false,
    () => i18n.t('CronJobs whose last run failed'),
    () => i18n.t('Open the failed Job and read its pod logs; fix the job or its schedule.'),
  ),
  // Cost insight: right-sizing report (only large, confident deltas).
  rule(
    'workload-overprovisioned',
    'efficiency',
    'info',
    [],
    false,
    () => i18n.t('Workloads requesting far more than they use'),
    () =>
      i18n.t(
        'Lower the requests to the right-sizing recommendation (Cost view) so nodes can be packed tighter.',
      ),
  ),
  rule(
    'workload-underprovisioned',
    'efficiency',
    'warning',
    [],
    false,
    () => i18n.t('Workloads using more than they request'),
    () =>
      i18n.t(
        'Raise the requests (and memory limits) to the right-sizing recommendation so pods are not throttled, evicted or OOM-killed.',
      ),
  ),
  // -- Network ----------------------------------------------------------------
  rule(
    'service-no-pods',
    'reliability',
    'warning',
    ['pods'],
    false,
    () => i18n.t('Services whose selector matches no pods'),
    () =>
      i18n.t(
        'Fix the Service selector or the pod labels; a Service without endpoints drops every connection.',
      ),
  ),
  rule(
    'service-no-ready-endpoints',
    'reliability',
    'critical',
    ['pods'],
    false,
    () => i18n.t('Services without ready endpoints'),
    () =>
      i18n.t('The selected pods exist but none is ready; check their readiness probes and logs.'),
  ),
  rule(
    'ingress-missing-service',
    'reliability',
    'critical',
    ['services'],
    false,
    () => i18n.t('Ingress backends pointing at missing Services'),
    () => i18n.t('Create the Service or fix the backend service name of the Ingress rule.'),
  ),
  rule(
    'ingress-missing-port',
    'reliability',
    'warning',
    ['services'],
    false,
    () => i18n.t('Ingress backends pointing at missing Service ports'),
    () => i18n.t('Use a port number or name that the backend Service exposes.'),
  ),
  rule(
    'ingress-missing-tls-secret',
    'security',
    'critical',
    ['secrets'],
    false,
    () => i18n.t('Ingress TLS secrets that do not exist'),
    () =>
      i18n.t(
        'Create the TLS secret (or its cert-manager Certificate); the controller serves a default certificate meanwhile.',
      ),
  ),
  // -- Config & storage hygiene -----------------------------------------------
  rule(
    'configmap-unused',
    'hygiene',
    'info',
    ['pods', ...WORKLOADS],
    false,
    () => i18n.t('ConfigMaps not referenced by any workload'),
    () =>
      i18n.t(
        'Delete ConfigMaps that nothing mounts or reads, or ignore the rule for namespaces where tools read them through the API.',
      ),
  ),
  rule(
    'secret-unused',
    'hygiene',
    'info',
    ['pods', 'serviceAccounts', 'ingresses', ...WORKLOADS],
    false,
    () => i18n.t('Secrets not referenced by any workload'),
    () =>
      i18n.t(
        'Delete Secrets that nothing mounts, reads or pulls with, or ignore the rule where controllers read them through the API.',
      ),
  ),
  rule(
    'pvc-unbound',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('PersistentVolumeClaims that are not bound'),
    () =>
      i18n.t('Check the StorageClass, provisioner events and whether a matching volume exists.'),
  ),
  rule(
    'pvc-unused',
    'hygiene',
    'info',
    ['pods', ...WORKLOADS],
    false,
    () => i18n.t('PersistentVolumeClaims not mounted by any pod'),
    () =>
      i18n.t(
        'Delete claims you no longer need; bound volumes keep costing storage while nothing mounts them.',
      ),
  ),
  // -- Policy -----------------------------------------------------------------
  rule(
    'pdb-blocks-drain',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('PodDisruptionBudgets allowing no disruptions'),
    () =>
      i18n.t(
        'Allow at least one disruption (maxUnavailable ≥ 1 or more replicas than minAvailable) or node drains will hang.',
      ),
  ),
  rule(
    'pdb-no-pods',
    'hygiene',
    'info',
    ['pods'],
    false,
    () => i18n.t('PodDisruptionBudgets matching no pods'),
    () => i18n.t('Fix the selector or delete the budget; it protects nothing.'),
  ),
  rule(
    'hpa-missing-target',
    'reliability',
    'critical',
    ['deployments', 'statefulSets'],
    false,
    () => i18n.t('HorizontalPodAutoscalers with a missing target'),
    () => i18n.t('Point scaleTargetRef at an existing workload or delete the autoscaler.'),
  ),
  rule(
    'hpa-no-cpu-requests',
    'reliability',
    'warning',
    ['deployments', 'statefulSets'],
    false,
    () => i18n.t('CPU autoscaling on containers without CPU requests'),
    () =>
      i18n.t(
        'CPU utilization is computed against requests; set resources.requests.cpu on every container of the target.',
      ),
  ),
  // -- Nodes ------------------------------------------------------------------
  rule(
    'node-not-ready',
    'reliability',
    'critical',
    [],
    true,
    () => i18n.t('Nodes that are not ready'),
    () => i18n.t('Check the kubelet and container runtime on the node, and its network.'),
  ),
  rule(
    'node-pressure',
    'reliability',
    'warning',
    [],
    true,
    () => i18n.t('Nodes under memory, disk or PID pressure'),
    () =>
      i18n.t(
        'Free resources or add capacity; the kubelet evicts pods while a pressure condition holds.',
      ),
  ),
  rule(
    'node-unschedulable',
    'efficiency',
    'info',
    [],
    true,
    () => i18n.t('Cordoned nodes'),
    () => i18n.t('Uncordon the node when maintenance is over; it accepts no new pods meanwhile.'),
  ),
  // -- Certificates -----------------------------------------------------------
  rule(
    'certificate-expired',
    'security',
    'critical',
    [],
    true,
    () => i18n.t('Expired certificates'),
    () =>
      i18n.t(
        'Renew the certificate now; clients reject expired certificates. With cert-manager, check the Certificate and its issuer.',
      ),
  ),
  rule(
    'certificate-expiring',
    'security',
    'warning',
    [],
    true,
    () => i18n.t('Certificates expiring within 30 days'),
    () =>
      i18n.t(
        'Renew the certificate before it expires, or make sure its automation (cert-manager) is healthy.',
      ),
  ),
  rule(
    'certificate-not-ready',
    'security',
    'warning',
    [],
    true,
    () => i18n.t('cert-manager Certificates that are not ready'),
    () => i18n.t('Read the Ready condition message and the CertificateRequest / Order events.'),
  ),
  // -- Pod Security Standards & RBAC (./securityRules.ts) ----------------------
  ...SECURITY_RULES,
];

const byId = new Map(RULES.map((r) => [r.id, r]));

export function ruleDef(id: string): RuleDef | undefined {
  return byId.get(id);
}

export function ruleTitle(id: string): string {
  return byId.get(id)?.title() ?? id;
}

export function severityLabel(s: Severity): string {
  switch (s) {
    case 'critical':
      return i18n.t('Critical');
    case 'warning':
      return i18n.t('Warning');
    default:
      return i18n.t('Info');
  }
}

export function categoryLabel(c: Category): string {
  switch (c) {
    case 'reliability':
      return i18n.t('Reliability');
    case 'security':
      return i18n.t('Security');
    case 'efficiency':
      return i18n.t('Efficiency');
    default:
      return i18n.t('Hygiene');
  }
}
