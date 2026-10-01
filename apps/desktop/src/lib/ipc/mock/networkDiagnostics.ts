import {
  runningContainers,
  servicePorts,
  validProbePath,
} from '@/components/workbench/network-diagnostics/model';
import { asArray, asObject, asString, asStringMap } from '@/lib/kube/accessors';
import { BUILTIN, kindKey } from '@/lib/kube/catalog';
import { buildCluster, simulate } from '@/lib/kube/netpol';
import type { ClusterDef } from '@/types';
import type {
  NetworkDiagnosticsReport,
  NetworkDiagnosticsRequest,
  NetworkProbeResult,
} from '@/types/networkDiagnostics';
import { mockDecide } from './access';
import { sleep } from './bus';
import { find, getDb, list } from './fixtures/db';
import { handlers, register } from './registry';

export async function demoNetworkDiagnostics(
  clusterId: string,
  request: NetworkDiagnosticsRequest,
): Promise<NetworkDiagnosticsReport> {
  const clusters = handlers.cluster_list?.({}) as ClusterDef[] | undefined;
  if (clusters?.find((c) => c.id === clusterId)?.read_only)
    throw new Error('network-diagnostics:read-only');
  const allowed = mockDecide(clusterId, {
    verb: 'create',
    group: '',
    resource: 'pods',
    subresource: 'exec',
    namespace: request.namespace,
    name: request.pod,
  });
  if (!allowed.allowed) throw new Error('network-diagnostics:exec-permission');
  if (!validProbePath(request.path)) throw new Error('network-diagnostics:invalid-path');
  if (!['tcp', 'http', 'https'].includes(request.protocol))
    throw new Error('network-diagnostics:invalid-name');
  const db = getDb(clusterId);
  const pod = find(db, kindKey(BUILTIN.Pod), request.namespace, request.pod);
  const service = find(db, kindKey(BUILTIN.Service), request.target_namespace, request.service);
  if (!runningContainers(pod).includes(request.container))
    throw new Error('network-diagnostics:source-not-running');
  if (!servicePorts(service).includes(request.port) || !service)
    throw new Error('network-diagnostics:invalid-service-port');
  await sleep(750);
  const slices = list(db, 'endpointslices.discovery.k8s.io').filter(
    (s) =>
      s.metadata.namespace === request.target_namespace &&
      s.metadata.labels?.['kubernetes.io/service-name'] === request.service,
  );
  const endpoints = slices.flatMap((s) => asArray(s.endpoints).map(asObject));
  const ready = endpoints.filter((e) => asObject(e.conditions).ready !== false);
  const cluster = buildCluster({
    pods: list(db, kindKey(BUILTIN.Pod)),
    services: list(db, kindKey(BUILTIN.Service)),
    namespaces: list(db, kindKey(BUILTIN.Namespace)),
    policies: list(db, kindKey(BUILTIN.NetworkPolicy)),
  });
  const verdict = simulate(cluster, {
    source: { type: 'pod', namespace: request.namespace, name: request.pod },
    destination: { type: 'service', namespace: request.target_namespace, name: request.service },
    protocol: 'TCP',
    port: request.port,
  });
  const blocked = verdict.verdict === 'denied';
  const failed = blocked || ready.length === 0;
  const host = `${request.service}.${request.target_namespace}.svc`;
  const probes: NetworkProbeResult[] = [
    {
      kind: 'dns',
      status: 'passed',
      reason: 'completed',
      command: ['timeout', '5', 'nslookup', host],
      output: `Name: ${host}\nAddress: ${asString(asObject(service.spec).clusterIP)}`,
      duration_ms: 12,
    },
    {
      kind: 'tcp',
      status: failed ? 'timed_out' : 'passed',
      reason: failed ? 'timeout' : 'completed',
      command: ['timeout', '5', 'nc', '-z', '-w', '4', host, String(request.port)],
      output: failed ? '' : `${host}:${request.port}`,
      duration_ms: failed ? 5000 : 18,
    },
  ];
  if (request.protocol === 'https')
    probes.push({
      kind: 'tls',
      status: failed ? 'timed_out' : 'passed',
      reason: failed ? 'timeout' : 'completed',
      command: [
        'timeout',
        '5',
        'openssl',
        's_client',
        '-brief',
        '-verify_return_error',
        '-verify_hostname',
        host,
        '-connect',
        `${host}:${request.port}`,
        '-servername',
        host,
      ],
      output: failed ? '' : 'CONNECTION ESTABLISHED\nProtocol version: TLSv1.3\nVerification: OK',
      duration_ms: failed ? 5000 : 27,
    });
  if (request.protocol !== 'tcp')
    probes.push({
      kind: 'http',
      status: failed ? 'timed_out' : 'passed',
      reason: failed ? 'timeout' : 'completed',
      command: [
        'curl',
        '--disable',
        '--noproxy',
        '*',
        '--silent',
        '--show-error',
        '--head',
        '--fail',
        '--output',
        '/dev/null',
        '--max-time',
        '5',
        '--connect-timeout',
        '3',
        '--proto',
        '=http,https',
        '--write-out',
        'HTTP %{http_code}\nRemote %{remote_ip}\nConnect %{time_connect}s\nTotal %{time_total}s\n',
        '--url',
        `${request.protocol}://${host}:${request.port}${request.path}`,
      ],
      output: failed
        ? ''
        : `HTTP 200\nRemote ${asString(asObject(service.spec).clusterIP)}\nTotal 0.031s`,
      duration_ms: failed ? 5000 : 31,
    });
  const externalName = asString(asObject(service.spec).externalName);
  if (externalName) {
    for (const probe of probes) {
      probe.status = 'unavailable';
      probe.reason = 'demo_external_name';
      probe.output = '';
      probe.duration_ms = 0;
    }
  }
  return {
    request: { ...request },
    host,
    checked_at: new Date().toISOString(),
    probes,
    service: {
      selector: asStringMap(asObject(service.spec).selector),
      cluster_ip: asString(asObject(service.spec).clusterIP) || null,
      external_name: asString(asObject(service.spec).externalName) || null,
      ready_endpoints: ready.length,
      unready_endpoints: endpoints.length - ready.length,
      addresses: endpoints
        .flatMap((e) => asArray(e.addresses).map((a) => asString(a)))
        .slice(0, 24),
      endpoints_error: null,
      endpoints_truncated: false,
    },
  };
}

register({
  network_diagnostics_run: ({ clusterId, request }) =>
    demoNetworkDiagnostics(clusterId, request as NetworkDiagnosticsRequest),
});
