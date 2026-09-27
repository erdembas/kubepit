import { list, put, type ClusterDb } from './db';
import { ago, between, DAY, hexId, HOUR, iso, meta, MIN, obj } from './util';

/** Demo nodes per platform: capacity, conditions, taints, leases. */

function nodeName(db: ClusterDb, i: number, gpu: boolean) {
  const p = db.profile;
  if (p.platform === 'EKS')
    return `ip-10-${p.ipBase}-${(i * 37) % 250}-${(i * 91 + 17) % 250}.${p.region}.compute.internal`;
  if (p.platform === 'GKE')
    return `gke-staging-${gpu ? 'gpu' : 'default'}-pool-${hexId(db.rand, 8)}-${hexId(db.rand, 4)}`;
  if (p.platform === 'AKS') return `aks-nodepool1-31718369-vmss${String(i).padStart(6, '0')}`;
  return i === 0 ? 'kind-kubepit-control-plane' : `kind-kubepit-worker${i === 1 ? '' : i}`;
}

const INSTANCE: Record<string, [string, string, string]> = {
  EKS: ['m6i.2xlarge', '8', '32386524Ki'],
  GKE: ['e2-standard-8', '8', '32874176Ki'],
  AKS: ['Standard_D4s_v5', '4', '16372604Ki'],
  kind: ['kind', '4', '8141716Ki'],
};

export function buildNodes(db: ClusterDb) {
  const p = db.profile;
  const [instance, cpu, memory] = INSTANCE[p.platform]!;
  for (let i = 0; i < p.nodes; i++) {
    const gpu = i >= p.nodes - p.gpuNodes;
    const controlPlane = p.platform === 'kind' && i === 0;
    const name = nodeName(db, i, gpu);
    const zone = p.zones.length ? p.zones[i % p.zones.length]! : '';
    const ip = `10.${p.ipBase}.${(i * 37) % 250}.${(i * 91 + 17) % 250}`;
    const age = (controlPlane ? 60 : between(db.rand, 3, 80)) * DAY + i * HOUR;
    const labels: Record<string, string> = {
      'beta.kubernetes.io/arch': 'amd64',
      'beta.kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
      'kubernetes.io/hostname': name,
      'kubernetes.io/os': 'linux',
      'node.kubernetes.io/instance-type': gpu ? 'g5.xlarge' : instance,
    };
    if (zone) {
      labels['topology.kubernetes.io/region'] = p.region;
      labels['topology.kubernetes.io/zone'] = zone;
    }
    if (p.platform === 'EKS') {
      labels['eks.amazonaws.com/nodegroup'] = gpu ? 'gpu' : 'general';
      labels['eks.amazonaws.com/capacityType'] = i % 5 === 4 ? 'SPOT' : 'ON_DEMAND';
      labels['node-role.kubernetes.io/worker'] = '';
    }
    if (p.platform === 'GKE')
      labels['cloud.google.com/gke-nodepool'] = gpu ? 'gpu-pool' : 'default-pool';
    if (p.platform === 'AKS') labels['kubernetes.azure.com/agentpool'] = 'nodepool1';
    if (controlPlane) labels['node-role.kubernetes.io/control-plane'] = '';
    if (gpu) labels['nvidia.com/gpu.present'] = 'true';

    const taints: Array<Record<string, string>> = [];
    if (controlPlane)
      taints.push({ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' });
    if (gpu) taints.push({ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' });
    const cordoned = p.cordoned === i;
    if (cordoned)
      taints.push({
        key: 'node.kubernetes.io/unschedulable',
        effect: 'NoSchedule',
        timeAdded: ago(3 * HOUR),
      });
    const notReady = p.notReady === i;
    if (notReady) {
      taints.push({
        key: 'node.kubernetes.io/unreachable',
        effect: 'NoSchedule',
        timeAdded: ago(26 * MIN),
      });
      taints.push({
        key: 'node.kubernetes.io/unreachable',
        effect: 'NoExecute',
        timeAdded: ago(21 * MIN),
      });
    }
    const heartbeat = notReady ? ago(27 * MIN) : ago(between(db.rand, 5, 40) * 1000);
    const condition = (type: string, status: string, reason: string, message: string) => ({
      type,
      status,
      reason,
      message,
      lastHeartbeatTime: heartbeat,
      lastTransitionTime: notReady ? ago(26 * MIN) : ago(age - 2 * MIN),
    });
    const unknown = (type: string) =>
      condition(type, 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting node status.');
    const cpuCap = gpu ? '4' : cpu;
    const memCap = gpu ? '16092456Ki' : memory;
    const allocCpu = `${Number(cpuCap) * 1000 - (Number(cpuCap) > 4 ? 90 : 70)}m`;
    const memKi = Number(memCap.replace('Ki', ''));
    put(
      db,
      obj(
        'v1',
        'Node',
        meta({
          name,
          age,
          labels,
          annotations: {
            'node.alpha.kubernetes.io/ttl': '0',
            'volumes.kubernetes.io/controller-managed-attach-detach': 'true',
            ...(p.platform === 'EKS' ? { 'alpha.kubernetes.io/provided-node-ip': ip } : {}),
          },
        }),
        {
          spec: {
            podCIDR: `10.${p.ipBase + 100}.${i}.0/24`,
            ...(p.platform === 'EKS'
              ? { providerID: `aws:///${zone}/i-0${hexId(db.rand, 16)}` }
              : {}),
            ...(taints.length ? { taints } : {}),
            ...(cordoned ? { unschedulable: true } : {}),
          },
          status: {
            capacity: {
              cpu: cpuCap,
              memory: memCap,
              pods: p.platform === 'EKS' ? '58' : '110',
              'ephemeral-storage': '104845292Ki',
              'hugepages-2Mi': '0',
              ...(gpu ? { 'nvidia.com/gpu': '1' } : {}),
            },
            allocatable: {
              cpu: allocCpu,
              memory: `${Math.round(memKi * 0.9)}Ki`,
              pods: p.platform === 'EKS' ? '58' : '110',
              'ephemeral-storage': '95551679124',
              'hugepages-2Mi': '0',
              ...(gpu ? { 'nvidia.com/gpu': '1' } : {}),
            },
            conditions: notReady
              ? [
                  unknown('MemoryPressure'),
                  unknown('DiskPressure'),
                  unknown('PIDPressure'),
                  unknown('Ready'),
                ]
              : [
                  condition(
                    'MemoryPressure',
                    'False',
                    'KubeletHasSufficientMemory',
                    'kubelet has sufficient memory available',
                  ),
                  condition(
                    'DiskPressure',
                    i === 5 && p.troubled ? 'True' : 'False',
                    i === 5 && p.troubled ? 'KubeletHasDiskPressure' : 'KubeletHasNoDiskPressure',
                    i === 5 && p.troubled
                      ? 'kubelet has disk pressure'
                      : 'kubelet has no disk pressure',
                  ),
                  condition(
                    'PIDPressure',
                    'False',
                    'KubeletHasSufficientPID',
                    'kubelet has sufficient PID available',
                  ),
                  condition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status'),
                ],
            addresses: [
              { type: 'InternalIP', address: ip },
              ...(p.platform === 'EKS' && i % 3 === 0
                ? [
                    {
                      type: 'ExternalIP',
                      address: `52.${18 + i}.${(i * 13) % 250}.${(i * 7) % 250}`,
                    },
                  ]
                : []),
              { type: 'Hostname', address: name },
              ...(p.platform === 'EKS' ? [{ type: 'InternalDNS', address: name }] : []),
            ],
            daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
            nodeInfo: {
              machineID: hexId(db.rand, 32),
              systemUUID: `ec2${hexId(db.rand, 5)}-${hexId(db.rand, 4)}-${hexId(db.rand, 4)}-${hexId(db.rand, 4)}-${hexId(db.rand, 12)}`,
              bootID: crypto.randomUUID(),
              kernelVersion:
                p.platform === 'EKS'
                  ? '6.1.124-134.200.amzn2023.x86_64'
                  : p.platform === 'GKE'
                    ? '6.1.100+'
                    : p.platform === 'AKS'
                      ? '5.15.0-1073-azure'
                      : '6.10.14-linuxkit',
              osImage:
                p.platform === 'EKS'
                  ? 'Amazon Linux 2023.6.20250123'
                  : p.platform === 'GKE'
                    ? 'Container-Optimized OS from Google'
                    : p.platform === 'AKS'
                      ? 'Ubuntu 22.04.5 LTS'
                      : 'Debian GNU/Linux 12 (bookworm)',
              containerRuntimeVersion:
                p.platform === 'GKE' ? 'containerd://1.7.24' : 'containerd://1.7.25',
              kubeletVersion: p.version.replace(/-gke\.\d+$/, ''),
              kubeProxyVersion: p.version,
              operatingSystem: 'linux',
              architecture: 'amd64',
            },
            images: [],
          },
        },
      ),
    );
    if (!notReady) {
      put(
        db,
        obj(
          'coordination.k8s.io/v1',
          'Lease',
          meta({
            name,
            namespace: 'kube-node-lease',
            age,
            owner: list(db, 'nodes').find((n) => n.metadata.name === name) ?? null,
          }),
          {
            spec: {
              holderIdentity: name,
              leaseDurationSeconds: 40,
              renewTime: iso(Date.now() - between(db.rand, 1, 9) * 1000),
            },
          },
        ),
      );
    }
  }
}
