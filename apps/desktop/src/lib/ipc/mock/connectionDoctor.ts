import type { ClusterDef } from '@/types';
import type {
  ConnectionDoctorCapabilityId,
  ConnectionDoctorReport,
  ConnectionDoctorStage,
} from '@/types/connectionDoctor';
import { sleep } from './bus';
import { handlers, register } from './registry';

const STAGES: ConnectionDoctorStage[] = [
  'kubeconfig',
  'auth-helper',
  'network',
  'tls',
  'api',
  'authentication',
  'permissions',
];

/** Entirely synthetic; running this must neither connect a fixture nor spawn tools. */
export function demoDoctorReport(
  cluster: ClusterDef,
  namespace?: string | null,
): ConnectionDoctorReport {
  const report: ConnectionDoctorReport = {
    cluster_id: cluster.id,
    namespace:
      namespace?.trim() ||
      cluster.default_namespace ||
      cluster.accessible_namespaces[0] ||
      'default',
    checked_at: Date.now(),
    elapsed_ms: 640,
    steps: [],
    capabilities: [],
    tools: [
      { id: 'kubectl', available: true },
      { id: 'helm', available: true },
    ],
    metrics_api:
      cluster.id === 'c-minikube' ? 'unchecked' : cluster.id === 'c-kind' ? 'missing' : 'available',
  };
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(report.namespace)) {
    report.steps.push({ stage: 'kubeconfig', status: 'failed', code: 'namespace-invalid' });
  } else {
    report.steps.push(
      { stage: 'kubeconfig', status: 'passed', code: 'kubeconfig-ready' },
      {
        stage: 'auth-helper',
        status: 'passed',
        code: cluster.id === 'c-kind' ? 'no-auth-helper' : 'auth-helper-ready',
      },
    );
    if (cluster.id === 'c-minikube') {
      report.steps.push({ stage: 'network', status: 'failed', code: 'tcp-failed' });
    } else {
      const restricted = cluster.read_only || cluster.id === 'c-staging';
      report.steps.push(
        {
          stage: 'network',
          status: 'passed',
          code: cluster.proxy_url ? 'proxy-reachable' : 'endpoint-reachable',
        },
        { stage: 'tls', status: 'passed', code: 'tls-verified' },
        { stage: 'api', status: 'passed', code: 'api-ready' },
        { stage: 'authentication', status: 'passed', code: 'identity-confirmed' },
        {
          stage: 'permissions',
          status: restricted ? 'warning' : 'passed',
          code: restricted ? 'permissions-limited' : 'permissions-ready',
        },
      );
      const ids: ConnectionDoctorCapabilityId[] = [
        'namespaces',
        'pods',
        'watches',
        'logs',
        'metrics',
        'helm',
        'exec',
        'rollouts',
      ];
      report.capabilities = ids.map((id) => ({
        id,
        allowed: !(cluster.id === 'c-staging' && (id === 'namespaces' || id === 'rollouts')),
        blocked_by_read_only: cluster.read_only && (id === 'exec' || id === 'rollouts'),
      }));
    }
  }
  for (const stage of STAGES) {
    if (!report.steps.some((s) => s.stage === stage))
      report.steps.push({ stage, status: 'skipped', code: 'previous-step-failed' });
  }
  return report;
}

register({
  connection_doctor_run: async ({ clusterId, namespace }) => {
    const clusters = (await handlers.cluster_list!({})) as ClusterDef[];
    const cluster = clusters.find((c) => c.id === clusterId);
    if (!cluster) throw new Error('Unknown cluster');
    await sleep(640);
    return demoDoctorReport(cluster, namespace);
  },
});
