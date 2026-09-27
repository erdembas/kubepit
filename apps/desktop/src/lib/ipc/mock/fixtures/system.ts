import { list, put, type ClusterDb } from './db';
import { buildDaemonSet, buildDeployment } from './builders';
import { buildService } from './network';
import { makePod } from './pods';
import { tpl, cfg } from './template';
import { DAY } from './util';

/** kube-system add-ons per platform (CNI, DNS, CSI, metrics-server, static pods). */

export function buildKubeSystem(db: ClusterDb) {
  const p = db.profile;
  const ns = 'kube-system';
  const critical = { priorityClassName: 'system-node-critical' };
  const version = p.version.split('-')[0]!;
  const proxyImage =
    p.platform === 'EKS'
      ? `602401143452.dkr.ecr.${p.region}.amazonaws.com/eks/kube-proxy:${version}-minimal-eksbuild.3`
      : `registry.k8s.io/kube-proxy:${version}`;
  buildDaemonSet(db, {
    namespace: ns,
    name: 'kube-proxy',
    age: 200 * DAY,
    template: tpl(
      'kube-proxy',
      [
        {
          name: 'kube-proxy',
          image: proxyImage,
          cpu: ['100m'],
          command: ['kube-proxy', '--v=2', '--config=/var/lib/kube-proxy-config/config'],
        },
      ],
      {
        ...critical,
        hostNetwork: true,
        sa: 'kube-proxy',
      },
    ),
  });
  if (p.platform === 'EKS') {
    buildDaemonSet(db, {
      namespace: ns,
      name: 'aws-node',
      age: 200 * DAY,
      template: tpl(
        'aws-node',
        [
          {
            name: 'aws-node',
            image: `602401143452.dkr.ecr.${p.region}.amazonaws.com/amazon-k8s-cni:v1.19.2-eksbuild.1`,
            ports: [{ name: 'metrics', port: 61678 }],
            cpu: ['25m'],
            env: [
              ['AWS_VPC_K8S_CNI_LOGLEVEL', 'DEBUG'],
              ['MY_NODE_NAME', { field: 'spec.nodeName' }],
            ],
          },
          {
            name: 'aws-eks-nodeagent',
            image: `602401143452.dkr.ecr.${p.region}.amazonaws.com/amazon/aws-network-policy-agent:v1.1.6-eksbuild.1`,
            cpu: ['25m'],
          },
        ],
        {
          ...critical,
          hostNetwork: true,
          sa: 'aws-node',
          init: [
            {
              name: 'aws-vpc-cni-init',
              image: `602401143452.dkr.ecr.${p.region}.amazonaws.com/amazon-k8s-cni-init:v1.19.2-eksbuild.1`,
              cpu: ['25m'],
            },
          ],
        },
      ),
    });
  }
  if (p.platform === 'kind') {
    buildDaemonSet(db, {
      namespace: ns,
      name: 'kindnet',
      age: 60 * DAY,
      template: tpl(
        'kindnet',
        [
          {
            name: 'kindnet-cni',
            image: 'docker.io/kindest/kindnetd:v20250214-acbabc1a',
            cpu: ['100m', '100m'],
            mem: ['50Mi', '50Mi'],
          },
        ],
        { hostNetwork: true, sa: 'kindnet' },
      ),
    });
    const cp = list(db, 'nodes').find(
      (n) => n.metadata.labels?.['node-role.kubernetes.io/control-plane'] !== undefined,
    );
    if (cp) {
      for (const [name, image, cpu] of [
        ['etcd', 'registry.k8s.io/etcd:3.5.16-0', '100m'],
        ['kube-apiserver', `registry.k8s.io/kube-apiserver:${version}`, '250m'],
        ['kube-controller-manager', `registry.k8s.io/kube-controller-manager:${version}`, '200m'],
        ['kube-scheduler', `registry.k8s.io/kube-scheduler:${version}`, '100m'],
      ] as const) {
        put(
          db,
          makePod(db, {
            namespace: ns,
            name: `${name}-${cp.metadata.name}`,
            owner: cp,
            template: tpl(name, [{ name, image, cpu: [cpu] }], {
              ...critical,
              hostNetwork: true,
              labels: { component: name, tier: 'control-plane' },
            }),
            age: 60 * DAY,
            node: cp.metadata.name,
          }),
        );
      }
    }
  }
  const dnsName = p.platform === 'GKE' ? 'kube-dns' : 'coredns';
  buildDeployment(db, {
    namespace: ns,
    name: dnsName,
    age: 200 * DAY,
    replicas: 2,
    oldRevisions: 1,
    template: tpl(
      dnsName,
      [
        {
          name: 'coredns',
          image:
            p.platform === 'EKS'
              ? `602401143452.dkr.ecr.${p.region}.amazonaws.com/eks/coredns:v1.11.4-eksbuild.2`
              : 'registry.k8s.io/coredns/coredns:v1.11.3',
          ports: [
            { name: 'dns', port: 53, protocol: 'UDP' },
            { name: 'dns-tcp', port: 53 },
            { name: 'metrics', port: 9153 },
          ],
          cpu: ['100m'],
          mem: ['70Mi', '170Mi'],
          args: ['-conf', '/etc/coredns/Corefile'],
          mounts: [['config-volume', '/etc/coredns', true]],
        },
      ],
      {
        priorityClassName: 'system-cluster-critical',
        sa: 'coredns',
        volumes: [cfg('coredns')],
        labels: { 'k8s-app': 'kube-dns' },
      },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'kube-dns',
    selector: { 'k8s-app': 'kube-dns' },
    ports: [
      { name: 'dns', port: 53, protocol: 'UDP' },
      { name: 'dns-tcp', port: 53 },
      { name: 'metrics', port: 9153 },
    ],
    labels: { 'k8s-app': 'kube-dns', 'kubernetes.io/name': 'CoreDNS' },
  });
  if (p.metrics) {
    buildDeployment(db, {
      namespace: ns,
      name: 'metrics-server',
      age: 150 * DAY,
      replicas: 1,
      template: tpl(
        'metrics-server',
        [
          {
            name: 'metrics-server',
            image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.2',
            ports: [{ name: 'https', port: 10250 }],
            cpu: ['100m'],
            mem: ['200Mi'],
            probe: 'tcp',
            args: [
              '--cert-dir=/tmp',
              '--secure-port=10250',
              '--kubelet-preferred-address-types=InternalIP',
              '--metric-resolution=15s',
            ],
          },
        ],
        { priorityClassName: 'system-cluster-critical', sa: 'metrics-server' },
      ),
    });
    buildService(db, {
      namespace: ns,
      name: 'metrics-server',
      selector: { app: 'metrics-server' },
      ports: [{ name: 'https', port: 443, targetPort: 10250 }],
    });
  }
  if (p.platform === 'EKS') {
    buildDeployment(db, {
      namespace: ns,
      name: 'ebs-csi-controller',
      age: 180 * DAY,
      replicas: 2,
      template: tpl(
        'ebs-csi-controller',
        [
          {
            name: 'ebs-plugin',
            image: 'public.ecr.aws/ebs-csi-driver/aws-ebs-csi-driver:v1.38.1',
            cpu: ['10m'],
            mem: ['40Mi', '256Mi'],
            ports: [{ name: 'healthz', port: 9808 }],
          },
          {
            name: 'csi-provisioner',
            image: 'public.ecr.aws/csi-components/csi-provisioner:v5.1.0-eksbuild.1',
            cpu: ['10m'],
            mem: ['40Mi', '256Mi'],
          },
          {
            name: 'csi-attacher',
            image: 'public.ecr.aws/csi-components/csi-attacher:v4.7.0-eksbuild.1',
            cpu: ['10m'],
            mem: ['40Mi', '256Mi'],
          },
          {
            name: 'liveness-probe',
            image: 'public.ecr.aws/csi-components/livenessprobe:v2.14.0-eksbuild.1',
            cpu: ['10m'],
            mem: ['40Mi', '256Mi'],
          },
        ],
        { sa: 'ebs-csi-controller-sa', priorityClassName: 'system-cluster-critical' },
      ),
    });
    buildDeployment(db, {
      namespace: ns,
      name: 'cluster-autoscaler',
      age: 150 * DAY,
      replicas: 1,
      template: tpl(
        'cluster-autoscaler',
        [
          {
            name: 'cluster-autoscaler',
            image: 'registry.k8s.io/autoscaling/cluster-autoscaler:v1.31.1',
            cpu: ['100m', '100m'],
            mem: ['600Mi', '600Mi'],
            ports: [8085],
          },
        ],
        { sa: 'cluster-autoscaler' },
      ),
    });
  }
  if (p.platform === 'GKE' || p.platform === 'AKS') {
    buildDeployment(db, {
      namespace: ns,
      name: 'konnectivity-agent',
      age: 150 * DAY,
      replicas: 2,
      template: tpl(
        'konnectivity-agent',
        [
          {
            name: 'konnectivity-agent',
            image: 'registry.k8s.io/kas-network-proxy/proxy-agent:v0.30.3',
            cpu: ['10m'],
            mem: ['30Mi', '125Mi'],
            ports: [{ name: 'admin', port: 8093 }],
          },
        ],
        { sa: 'konnectivity-agent', priorityClassName: 'system-cluster-critical' },
      ),
    });
  }
  if (p.platform === 'kind') {
    buildDeployment(db, {
      namespace: 'local-path-storage',
      name: 'local-path-provisioner',
      age: 60 * DAY,
      replicas: 1,
      template: tpl(
        'local-path-provisioner',
        [
          {
            name: 'local-path-provisioner',
            image: 'docker.io/kindest/local-path-provisioner:v20250214-acbabc1a',
            command: [
              'local-path-provisioner',
              '--debug',
              'start',
              '--helper-image',
              'docker.io/kindest/local-path-helper:v20241212-8ac705d0',
              '--config',
              '/etc/config/config.json',
            ],
            mounts: [['config-volume', '/etc/config/']],
          },
        ],
        { sa: 'local-path-provisioner-service-account', volumes: [cfg('local-path-config')] },
      ),
    });
  }
}
