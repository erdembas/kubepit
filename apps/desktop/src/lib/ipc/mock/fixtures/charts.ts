import YAML from 'yaml';
import type { HelmChartDependency, HelmChartMaintainer, HelmRepo } from '@/types';

/**
 * Demo Helm chart catalog: the repositories a user typically has configured
 * plus a few more that Artifact Hub knows about, each with charts, version
 * series, READMEs (Markdown with tables and code blocks), commented default
 * values and a manifest renderer used by the demo install/upgrade.
 */

export interface KnownRepo extends HelmRepo {
  /** Adding the repository requires basic auth (demo credential check). */
  auth?: boolean;
  org: string;
}

export const KNOWN_REPOS: KnownRepo[] = [
  { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami', org: 'Bitnami' },
  {
    name: 'prometheus-community',
    url: 'https://prometheus-community.github.io/helm-charts',
    org: 'Prometheus Community',
  },
  { name: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx', org: 'Kubernetes' },
  { name: 'jetstack', url: 'https://charts.jetstack.io', org: 'Jetstack' },
  { name: 'grafana', url: 'https://grafana.github.io/helm-charts', org: 'Grafana Labs' },
  { name: 'argo', url: 'https://argoproj.github.io/argo-helm', org: 'Argo Project' },
  { name: 'traefik', url: 'https://traefik.github.io/charts', org: 'Traefik Labs' },
  { name: 'hashicorp', url: 'https://helm.releases.hashicorp.com', org: 'HashiCorp' },
  { name: 'kedacore', url: 'https://kedacore.github.io/charts', org: 'KEDA' },
  { name: 'external-secrets', url: 'https://charts.external-secrets.io', org: 'External Secrets' },
  { name: 'cilium', url: 'https://helm.cilium.io', org: 'Cilium' },
  { name: 'kyverno', url: 'https://kyverno.github.io/kyverno', org: 'Kyverno' },
  {
    name: 'open-telemetry',
    url: 'https://open-telemetry.github.io/opentelemetry-helm-charts',
    org: 'OpenTelemetry',
  },
  { name: 'acme', url: 'https://charts.acme.io/stable', org: 'ACME Platform', auth: true },
];

export const INITIAL_REPOS = [
  'bitnami',
  'prometheus-community',
  'ingress-nginx',
  'jetstack',
  'grafana',
];

type Param = [path: string, description: string, value: unknown];

export interface ChartDef {
  repo: string;
  chart: string;
  title: string;
  description: string;
  /** Newest first: [chart version, app version]. */
  versions: Array<[string, string]>;
  keywords: string[];
  home: string;
  sources: string[];
  maintainers: HelmChartMaintainer[];
  dependencies?: HelmChartDependency[];
  kube?: string;
  type?: 'application' | 'library';
  deprecated?: boolean;
  image: string;
  port: number;
  workload: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  params: Param[];
  notes?: string;
  /** Extra Markdown inserted before "Parameters". */
  details?: string;
}

/**
 * A version series walking back from `latest`: patch releases first, then
 * earlier minors (deterministic, so demo releases can pin exact versions).
 */
function series(latest: string, app: string, count = 9): Array<[string, string]> {
  const parse = (v: string) => {
    const prefix = v.startsWith('v') ? 'v' : '';
    const [a = 0, b = 0, c = 0] = v.replace(/^v/, '').split('.').map(Number);
    return { prefix, a, b, c };
  };
  const chart = parse(latest);
  const appV = parse(app);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < count; i++) {
    out.push([
      `${chart.prefix}${chart.a}.${chart.b}.${chart.c}`,
      `${appV.prefix}${appV.a}.${appV.b}.${appV.c}`,
    ]);
    if (chart.c > 0) {
      chart.c--;
      if (appV.c > 0 && i % 2 === 0) appV.c--;
    } else if (chart.b > 0) {
      chart.b--;
      chart.c = 2 + (i % 3);
      if (appV.b > 0) {
        appV.b--;
        appV.c = 3;
      }
    } else {
      chart.a--;
      chart.b = 3;
      chart.c = 1;
      if (appV.b > 0) appV.b--;
      else if (appV.a > 0) {
        appV.a--;
        appV.b = 9;
      }
    }
    if (chart.a < 0) break;
  }
  return out;
}

const BITNAMI_MAINTAINER: HelmChartMaintainer = {
  name: 'Broadcom, Inc. All Rights Reserved.',
  email: null,
  url: 'https://github.com/bitnami/charts',
};
const COMMON_DEP: HelmChartDependency = {
  name: 'common',
  version: '2.x.x',
  repository: 'oci://registry-1.docker.io/bitnamicharts',
  condition: null,
};

function commonParams(image: string, tag: string, port: number, stateful: boolean): Param[] {
  const params: Param[] = [
    ['global.imageRegistry', 'Global Docker image registry', ''],
    ['global.imagePullSecrets', 'Global Docker registry secret names as an array', []],
    ['nameOverride', 'String to partially override the fullname template', ''],
    ['fullnameOverride', 'String to fully override the fullname template', ''],
    ['replicaCount', 'Number of replicas to deploy', 1],
    ['image.registry', 'Image registry', 'docker.io'],
    ['image.repository', 'Image repository', image],
    ['image.tag', 'Image tag (immutable tags are recommended)', tag],
    ['image.pullPolicy', 'Image pull policy', 'IfNotPresent'],
    ['service.type', 'Service type', 'ClusterIP'],
    ['service.port', 'Service port', port],
    ['ingress.enabled', 'Enable ingress record generation', false],
    ['ingress.ingressClassName', 'IngressClass that will be used to implement the Ingress', ''],
    ['ingress.hostname', 'Default host for the ingress record', `${image.split('/').pop()}.local`],
    ['ingress.tls', 'Enable TLS configuration for the host defined at `ingress.hostname`', false],
    ['resources.requests.cpu', 'CPU request of the main container', '100m'],
    ['resources.requests.memory', 'Memory request of the main container', '128Mi'],
    ['resources.limits.memory', 'Memory limit of the main container', '512Mi'],
    ['podSecurityContext.enabled', 'Enable the pod security context', true],
    ['podSecurityContext.fsGroup', 'Group ID for the volumes of the pod', 1001],
    ['nodeSelector', 'Node labels for pod assignment', {}],
    ['tolerations', 'Tolerations for pod assignment', []],
    ['metrics.enabled', 'Start a sidecar Prometheus exporter', false],
    [
      'metrics.serviceMonitor.enabled',
      'Create a ServiceMonitor (requires the Prometheus Operator)',
      false,
    ],
  ];
  if (stateful)
    params.push(
      ['persistence.enabled', 'Enable persistence using Persistent Volume Claims', true],
      ['persistence.storageClass', 'Persistent Volume storage class', ''],
      ['persistence.size', 'Persistent Volume size', '8Gi'],
    );
  return params;
}

interface Spec {
  repo: string;
  chart: string;
  title: string;
  description: string;
  latest?: string;
  app?: string;
  versions?: Array<[string, string]>;
  count?: number;
  keywords: string[];
  home: string;
  source?: string;
  image: string;
  port: number;
  workload?: ChartDef['workload'];
  params?: Param[];
  deps?: HelmChartDependency[];
  kube?: string;
  deprecated?: boolean;
  notes?: string;
  details?: string;
  maintainers?: HelmChartMaintainer[];
  type?: ChartDef['type'];
}

function chart(spec: Spec): ChartDef {
  const versions = spec.versions ?? series(spec.latest!, spec.app!, spec.count);
  const stateful = spec.workload === 'StatefulSet';
  const bitnami = spec.repo === 'bitnami';
  return {
    repo: spec.repo,
    chart: spec.chart,
    title: spec.title,
    description: spec.deprecated ? `DEPRECATED ${spec.description}` : spec.description,
    versions,
    keywords: spec.keywords,
    home: spec.home,
    sources: [
      spec.source ??
        (bitnami
          ? `https://github.com/bitnami/charts/tree/main/bitnami/${spec.chart}`
          : `https://github.com/${spec.repo}/helm-charts`),
    ],
    maintainers:
      spec.maintainers ??
      (bitnami
        ? [BITNAMI_MAINTAINER]
        : [{ name: `${spec.repo} maintainers`, email: `maintainers@${spec.repo}.io`, url: null }]),
    dependencies: spec.deps ?? (bitnami ? [COMMON_DEP] : []),
    kube: spec.kube ?? (bitnami ? '>=1.23.0-0' : undefined),
    type: spec.type ?? 'application',
    deprecated: spec.deprecated,
    image: spec.image,
    port: spec.port,
    workload: spec.workload ?? 'Deployment',
    params: [
      ...commonParams(spec.image, versions[0]![1], spec.port, stateful),
      ...(spec.params ?? []),
    ],
    notes: spec.notes,
    details: spec.details,
  };
}

export const CHARTS: ChartDef[] = [
  // -- bitnami ---------------------------------------------------------------
  chart({
    repo: 'bitnami',
    chart: 'nginx',
    title: 'NGINX Open Source',
    description:
      'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache.',
    latest: '18.3.1',
    app: '1.27.3',
    count: 12,
    keywords: ['nginx', 'http', 'web', 'www', 'reverse proxy'],
    home: 'https://bitnami.com',
    image: 'bitnami/nginx',
    port: 80,
    params: [
      ['serverBlock', 'Custom server block to be added to the NGINX configuration', ''],
      [
        'staticSiteConfigmap',
        'Name of an existing ConfigMap with the server static site content',
        '',
      ],
      [
        'cloneStaticSiteFromGit.enabled',
        'Get the server static content from a Git repository',
        false,
      ],
      ['cloneStaticSiteFromGit.repository', 'Git repository to clone static content from', ''],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'postgresql',
    title: 'PostgreSQL',
    description:
      'PostgreSQL (Postgres) is an open source object-relational database known for reliability and data integrity. ACID-compliant, it supports foreign keys, joins, views, triggers and stored procedures.',
    versions: [
      ['16.4.5', '17.2.0'],
      ['16.4.2', '17.2.0'],
      ['16.3.5', '17.2.0'],
      ['16.3.0', '17.0.0'],
      ['16.2.5', '16.6.0'],
      ['16.2.2', '16.4.0'],
      ['16.0.6', '16.4.0'],
      ['15.5.38', '16.4.0'],
      ['15.5.20', '16.3.0'],
    ],
    keywords: ['postgresql', 'postgres', 'database', 'sql', 'replication', 'cluster'],
    home: 'https://bitnami.com',
    image: 'bitnami/postgresql',
    port: 5432,
    workload: 'StatefulSet',
    params: [
      ['architecture', 'PostgreSQL architecture (`standalone` or `replication`)', 'standalone'],
      ['auth.enablePostgresUser', 'Assign a password to the "postgres" admin user', true],
      ['auth.database', 'Name for a custom database to create', ''],
      ['auth.existingSecret', 'Name of existing secret to use for PostgreSQL credentials', ''],
      ['primary.extendedConfiguration', 'Extended PostgreSQL Primary configuration', ''],
      ['readReplicas.replicaCount', 'Number of PostgreSQL read only replicas', 1],
    ],
    notes: 'postgres',
  }),
  chart({
    repo: 'bitnami',
    chart: 'redis',
    title: 'Redis®',
    description:
      'Redis(R) is an open source, advanced key-value store. It is often referred to as a data structure server since keys can contain strings, hashes, lists, sets and sorted sets.',
    versions: [
      ['20.11.3', '7.4.2'],
      ['20.8.0', '7.4.2'],
      ['20.6.3', '7.4.2'],
      ['20.6.2', '7.4.2'],
      ['20.4.0', '7.4.1'],
      ['20.1.4', '7.4.0'],
      ['19.6.4', '7.2.5'],
      ['21.0.0-rc.1', '8.0.0-m02'],
    ],
    keywords: ['redis', 'keyvalue', 'database'],
    home: 'https://bitnami.com',
    image: 'bitnami/redis',
    port: 6379,
    workload: 'StatefulSet',
    params: [
      [
        'architecture',
        'Redis(R) architecture. Allowed values: `standalone` or `replication`',
        'replication',
      ],
      ['auth.enabled', 'Enable password authentication', true],
      ['auth.sentinel', 'Enable password authentication on sentinels too', true],
      ['replica.replicaCount', 'Number of Redis(R) replicas to deploy', 3],
      ['sentinel.enabled', 'Use Redis(R) Sentinel on Redis(R) pods', false],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'mysql',
    title: 'MySQL',
    description:
      'MySQL is a fast, reliable, scalable, and easy to use open source relational database system. Designed to handle mission-critical, heavy-load production applications.',
    latest: '12.2.1',
    app: '8.4.4',
    keywords: ['mysql', 'database', 'sql', 'cluster', 'high availability'],
    home: 'https://bitnami.com',
    image: 'bitnami/mysql',
    port: 3306,
    workload: 'StatefulSet',
    params: [
      ['architecture', 'MySQL architecture (`standalone` or `replication`)', 'standalone'],
      ['auth.database', 'Name for a custom database to create', 'my_database'],
      ['auth.username', 'Name for a custom user to create', ''],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'mongodb',
    title: 'MongoDB®',
    description:
      'MongoDB(R) is a relational open source NoSQL database. Easy to use, it stores data in JSON-like documents. Automated scalability and high-performance. Ideal for developing cloud native applications.',
    latest: '16.4.2',
    app: '8.0.4',
    keywords: ['mongodb', 'database', 'nosql', 'cluster', 'replicaset', 'replication'],
    home: 'https://bitnami.com',
    image: 'bitnami/mongodb',
    port: 27017,
    workload: 'StatefulSet',
    params: [
      ['architecture', 'MongoDB(R) architecture (`standalone` or `replicaset`)', 'standalone'],
      ['auth.rootUser', 'MongoDB(R) root user', 'root'],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'kafka',
    title: 'Apache Kafka',
    description:
      'Apache Kafka is a distributed streaming platform designed to build real-time pipelines and can be used as a message broker or as a replacement for a log aggregation solution for big data applications.',
    latest: '31.3.1',
    app: '3.9.0',
    keywords: ['kafka', 'zookeeper', 'kraft', 'streaming', 'producer', 'consumer'],
    home: 'https://bitnami.com',
    image: 'bitnami/kafka',
    port: 9092,
    workload: 'StatefulSet',
    params: [
      ['controller.replicaCount', 'Number of Kafka controller-eligible nodes', 3],
      ['broker.replicaCount', 'Number of Kafka broker-only nodes', 0],
      [
        'listeners.client.protocol',
        'Security protocol for the Kafka client listener',
        'SASL_PLAINTEXT',
      ],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'rabbitmq',
    title: 'RabbitMQ',
    description:
      'RabbitMQ is an open source general-purpose message broker that is designed for consistent, highly-available messaging scenarios (both synchronous and asynchronous).',
    latest: '15.3.2',
    app: '4.0.5',
    keywords: ['rabbitmq', 'message queue', 'AMQP'],
    home: 'https://bitnami.com',
    image: 'bitnami/rabbitmq',
    port: 5672,
    workload: 'StatefulSet',
    params: [['auth.username', 'RabbitMQ application username', 'user']],
  }),
  chart({
    repo: 'bitnami',
    chart: 'keycloak',
    title: 'Keycloak',
    description:
      'Keycloak is a high performance Java-based identity and access management solution. It lets developers add an authentication layer to their applications with minimum effort.',
    latest: '24.4.9',
    app: '26.1.1',
    keywords: ['keycloak', 'access-management', 'identity', 'sso', 'oidc'],
    home: 'https://bitnami.com',
    image: 'bitnami/keycloak',
    port: 8080,
    workload: 'StatefulSet',
    deps: [
      COMMON_DEP,
      {
        name: 'postgresql',
        version: '16.x.x',
        repository: 'oci://registry-1.docker.io/bitnamicharts',
        condition: 'postgresql.enabled',
      },
    ],
    params: [
      ['auth.adminUser', 'Keycloak administrator user', 'user'],
      ['production', 'Run Keycloak in production mode (TLS required)', false],
      ['postgresql.enabled', 'Switch to enable or disable the PostgreSQL helm chart', true],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'minio',
    title: 'MinIO®',
    description:
      'MinIO(R) is an object storage server, compatible with Amazon S3 cloud storage service, mainly used for storing unstructured data (such as photos, videos, log files, etc.).',
    latest: '15.0.3',
    app: '2025.1.20',
    keywords: ['minio', 'storage', 'object-storage', 's3', 'cluster'],
    home: 'https://bitnami.com',
    image: 'bitnami/minio',
    port: 9000,
    params: [
      ['mode', 'MinIO(R) server mode (`standalone` or `distributed`)', 'standalone'],
      [
        'defaultBuckets',
        'Comma, semi-colon or space separated list of buckets to create at initialization',
        '',
      ],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'wordpress',
    title: 'WordPress',
    description:
      "WordPress is the world's most popular blogging and content management platform. Powerful yet simple, everyone from students to global corporations use it to build beautiful, functional websites.",
    latest: '24.1.9',
    app: '6.7.1',
    keywords: ['application', 'blog', 'cms', 'http', 'php', 'web', 'wordpress'],
    home: 'https://bitnami.com',
    image: 'bitnami/wordpress',
    port: 8080,
    deps: [
      COMMON_DEP,
      {
        name: 'mariadb',
        version: '20.x.x',
        repository: 'oci://registry-1.docker.io/bitnamicharts',
        condition: 'mariadb.enabled',
      },
      {
        name: 'memcached',
        version: '7.x.x',
        repository: 'oci://registry-1.docker.io/bitnamicharts',
        condition: 'memcached.enabled',
      },
    ],
    params: [
      ['wordpressUsername', 'WordPress username', 'user'],
      ['wordpressBlogName', 'Blog name', "User's Blog!"],
      [
        'mariadb.enabled',
        'Deploy a MariaDB server to satisfy the applications database requirements',
        true,
      ],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'external-dns',
    title: 'ExternalDNS',
    description:
      'ExternalDNS is a Kubernetes addon that configures public DNS servers with information about exposed Kubernetes services to make them discoverable.',
    latest: '8.7.3',
    app: '0.15.1',
    keywords: ['external-dns', 'network', 'dns'],
    home: 'https://bitnami.com',
    image: 'bitnami/external-dns',
    port: 7979,
    params: [
      ['provider', 'DNS provider where the DNS records will be created', 'aws'],
      [
        'policy',
        'Modify how DNS records are synchronized (`sync` or `upsert-only`)',
        'upsert-only',
      ],
      ['domainFilters', 'Limit possible target zones by domain suffixes', []],
    ],
  }),
  chart({
    repo: 'bitnami',
    chart: 'sealed-secrets',
    title: 'Sealed Secrets',
    description:
      'Sealed Secrets are "one-way" encrypted K8s Secrets that can be created by anyone, but can only be decrypted by the controller running in the target cluster.',
    latest: '2.5.2',
    app: '0.28.0',
    keywords: ['secrets', 'sealed-secrets', 'gitops'],
    home: 'https://bitnami.com',
    image: 'bitnami/sealed-secrets-controller',
    port: 8080,
  }),
  chart({
    repo: 'bitnami',
    chart: 'memcached',
    title: 'Memcached',
    description:
      'Memcached is an high-performance, distributed memory object caching system, generic in nature, but intended for use in speeding up dynamic web applications by alleviating database load.',
    latest: '7.6.3',
    app: '1.6.34',
    keywords: ['memcached', 'cache'],
    home: 'https://bitnami.com',
    image: 'bitnami/memcached',
    port: 11211,
  }),
  chart({
    repo: 'bitnami',
    chart: 'nginx-ingress-controller',
    title: 'NGINX Ingress Controller',
    description:
      'NGINX Ingress Controller is an Ingress controller that manages external access to HTTP services in a Kubernetes cluster using NGINX.',
    latest: '11.6.8',
    app: '1.12.0',
    keywords: ['ingress', 'nginx', 'http', 'web', 'www', 'reverse proxy'],
    home: 'https://bitnami.com',
    image: 'bitnami/nginx-ingress-controller',
    port: 80,
    deprecated: true,
  }),
  // -- prometheus-community -------------------------------------------------
  chart({
    repo: 'prometheus-community',
    chart: 'kube-prometheus-stack',
    title: 'kube-prometheus-stack',
    description:
      'kube-prometheus-stack collects Kubernetes manifests, Grafana dashboards, and Prometheus rules combined with documentation and scripts to provide easy to operate end-to-end Kubernetes cluster monitoring with Prometheus using the Prometheus Operator.',
    latest: '69.2.4',
    app: 'v0.80.0',
    count: 12,
    keywords: ['operator', 'prometheus', 'kube-prometheus'],
    home: 'https://github.com/prometheus-operator/kube-prometheus',
    source: 'https://github.com/prometheus-community/helm-charts',
    image: 'prometheus-operator/prometheus-operator',
    port: 9090,
    kube: '>=1.19.0-0',
    maintainers: [
      { name: 'andrewgkew', email: 'andrew@quadcorps.co.uk', url: null },
      { name: 'gianrubio', email: 'gianrubio@gmail.com', url: null },
      { name: 'QuentinBisson', email: 'quentin.bisson@gmail.com', url: null },
    ],
    deps: [
      { name: 'crds', version: '0.0.0', repository: null, condition: 'crds.enabled' },
      {
        name: 'kube-state-metrics',
        version: '5.28.*',
        repository: 'https://prometheus-community.github.io/helm-charts',
        condition: 'kubeStateMetrics.enabled',
      },
      {
        name: 'prometheus-node-exporter',
        version: '4.43.*',
        repository: 'https://prometheus-community.github.io/helm-charts',
        condition: 'nodeExporter.enabled',
      },
      {
        name: 'grafana',
        version: '8.8.*',
        repository: 'https://grafana.github.io/helm-charts',
        condition: 'grafana.enabled',
      },
    ],
    params: [
      ['alertmanager.enabled', 'Deploy Alertmanager', true],
      ['grafana.enabled', 'Deploy Grafana as a dependency', true],
      ['grafana.adminPassword', 'Grafana admin password', 'prom-operator'],
      ['kubeStateMetrics.enabled', 'Deploy kube-state-metrics', true],
      ['nodeExporter.enabled', 'Deploy the Prometheus node exporter', true],
      ['prometheus.prometheusSpec.replicas', 'Number of Prometheus replicas', 1],
      ['prometheus.prometheusSpec.retention', 'How long to retain metrics', '10d'],
      [
        'prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues',
        'Only select ServiceMonitors labelled with the release',
        true,
      ],
    ],
    details: `### Multiple releases

The same chart can be used to run multiple Prometheus instances in the same cluster if required. To achieve this, it is necessary to run only one instance of prometheus-operator and a pair of alertmanager pods for an HA configuration, while all other components need to be disabled.

> **Note**: The CRDs are not updated by \`helm upgrade\`. Apply them manually before upgrading across major versions:
>
> \`\`\`console
> kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.80.0/example/prometheus-operator-crd/monitoring.coreos.com_alertmanagerconfigs.yaml
> \`\`\`
`,
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'prometheus',
    title: 'Prometheus',
    description: 'Prometheus is a monitoring system and time series database.',
    latest: '27.3.1',
    app: 'v3.1.0',
    keywords: ['monitoring', 'prometheus'],
    home: 'https://prometheus.io/',
    source: 'https://github.com/prometheus/prometheus',
    image: 'prometheus/prometheus',
    port: 9090,
    workload: 'StatefulSet',
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'prometheus-node-exporter',
    title: 'Prometheus Node Exporter',
    description: 'A Helm chart for prometheus node-exporter',
    latest: '4.43.1',
    app: '1.8.2',
    keywords: ['node-exporter', 'prometheus', 'exporter'],
    home: 'https://github.com/prometheus/node_exporter/',
    image: 'prometheus/node-exporter',
    port: 9100,
    workload: 'DaemonSet',
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'kube-state-metrics',
    title: 'kube-state-metrics',
    description: 'Install kube-state-metrics to generate and expose cluster-level metrics',
    latest: '5.29.0',
    app: '2.14.0',
    keywords: ['metric', 'monitoring', 'prometheus', 'kubernetes'],
    home: 'https://github.com/kubernetes/kube-state-metrics/',
    image: 'kube-state-metrics/kube-state-metrics',
    port: 8080,
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'alertmanager',
    title: 'Alertmanager',
    description:
      'The Alertmanager handles alerts sent by client applications such as the Prometheus server.',
    latest: '1.15.1',
    app: 'v0.28.0',
    keywords: ['monitoring'],
    home: 'https://prometheus.io/',
    image: 'prometheus/alertmanager',
    port: 9093,
    workload: 'StatefulSet',
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'prometheus-blackbox-exporter',
    title: 'Blackbox Exporter',
    description: 'Prometheus Blackbox Exporter',
    latest: '9.2.0',
    app: 'v0.25.0',
    keywords: ['prometheus', 'blackbox', 'monitoring'],
    home: 'https://github.com/prometheus/blackbox_exporter',
    image: 'prometheus/blackbox-exporter',
    port: 9115,
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'prometheus-postgres-exporter',
    title: 'PostgreSQL Exporter',
    description: 'A Helm chart for prometheus postgres-exporter',
    latest: '6.8.1',
    app: 'v0.16.0',
    keywords: ['postgres', 'prometheus', 'exporter'],
    home: 'https://github.com/prometheus-community/postgres_exporter',
    image: 'prometheuscommunity/postgres-exporter',
    port: 9187,
  }),
  chart({
    repo: 'prometheus-community',
    chart: 'prometheus-adapter',
    title: 'Prometheus Adapter',
    description:
      'A Helm chart for k8s prometheus adapter, an implementation of the custom.metrics.k8s.io API using Prometheus',
    latest: '4.11.0',
    app: 'v0.12.0',
    keywords: ['hpa', 'metrics', 'prometheus', 'adapter'],
    home: 'https://github.com/kubernetes-sigs/prometheus-adapter',
    image: 'prometheus-adapter/prometheus-adapter',
    port: 6443,
  }),
  // -- ingress-nginx ----------------------------------------------------------
  chart({
    repo: 'ingress-nginx',
    chart: 'ingress-nginx',
    title: 'ingress-nginx',
    description:
      'Ingress controller for Kubernetes using NGINX as a reverse proxy and load balancer',
    versions: [
      ['4.13.0', '1.13.0'],
      ['4.12.1', '1.12.1'],
      ['4.12.0', '1.12.0'],
      ['4.11.4', '1.11.4'],
      ['4.11.3', '1.11.3'],
      ['4.11.2', '1.11.2'],
      ['4.10.1', '1.10.1'],
      ['4.10.0', '1.10.0'],
      ['4.14.0-beta.0', '1.14.0-beta.0'],
    ],
    keywords: ['ingress', 'nginx'],
    home: 'https://github.com/kubernetes/ingress-nginx',
    source: 'https://github.com/kubernetes/ingress-nginx',
    image: 'ingress-nginx/controller',
    port: 80,
    kube: '>=1.21.0-0',
    maintainers: [
      { name: 'rikatz', email: null, url: null },
      { name: 'strongjz', email: null, url: null },
      { name: 'Gacko', email: null, url: null },
    ],
    params: [
      ['controller.ingressClassResource.name', 'Name of the IngressClass', 'nginx'],
      [
        'controller.ingressClassResource.default',
        'Mark the IngressClass as the cluster default',
        false,
      ],
      ['controller.config', 'Global NGINX configuration (ConfigMap entries)', {}],
      [
        'controller.admissionWebhooks.enabled',
        'Validate Ingress objects with an admission webhook',
        true,
      ],
    ],
    notes: 'ingress',
  }),
  // -- jetstack ---------------------------------------------------------------
  chart({
    repo: 'jetstack',
    chart: 'cert-manager',
    title: 'cert-manager',
    description:
      'A Helm chart for cert-manager, which adds certificates and certificate issuers as resource types in Kubernetes clusters and simplifies obtaining, renewing and using them.',
    versions: [
      ['v1.17.1', 'v1.17.1'],
      ['v1.17.0', 'v1.17.0'],
      ['v1.16.3', 'v1.16.3'],
      ['v1.16.2', 'v1.16.2'],
      ['v1.16.1', 'v1.16.1'],
      ['v1.15.4', 'v1.15.4'],
      ['v1.15.3', 'v1.15.3'],
      ['v1.14.7', 'v1.14.7'],
    ],
    keywords: ['cert-manager', 'kube-lego', 'letsencrypt', 'tls'],
    home: 'https://cert-manager.io',
    source: 'https://github.com/cert-manager/cert-manager',
    image: 'jetstack/cert-manager-controller',
    port: 9402,
    kube: '>= 1.22.0-0',
    maintainers: [
      {
        name: 'cert-manager-maintainers',
        email: 'cert-manager-maintainers@googlegroups.com',
        url: 'https://cert-manager.io',
      },
    ],
    params: [
      ['crds.enabled', 'Install the cert-manager CRDs with the chart', false],
      ['crds.keep', 'Keep the CRDs when the chart is uninstalled', true],
      ['prometheus.enabled', 'Enable Prometheus monitoring', true],
      ['webhook.timeoutSeconds', 'Webhook timeout in seconds', 30],
    ],
    notes: 'certmanager',
  }),
  chart({
    repo: 'jetstack',
    chart: 'trust-manager',
    title: 'trust-manager',
    description:
      'trust-manager is the easiest way to manage TLS trust bundles in Kubernetes and OpenShift clusters',
    latest: 'v0.15.0',
    app: 'v0.15.0',
    keywords: ['cert-manager', 'trust-manager', 'tls'],
    home: 'https://cert-manager.io/docs/trust/trust-manager/',
    source: 'https://github.com/cert-manager/trust-manager',
    image: 'jetstack/trust-manager',
    port: 6443,
  }),
  chart({
    repo: 'jetstack',
    chart: 'cert-manager-csi-driver',
    title: 'cert-manager csi-driver',
    description: 'cert-manager csi-driver enables issuing secretless X.509 certificates for pods',
    latest: 'v0.10.2',
    app: 'v0.10.2',
    keywords: ['cert-manager', 'csi', 'tls'],
    home: 'https://cert-manager.io/docs/usage/csi-driver/',
    source: 'https://github.com/cert-manager/csi-driver',
    image: 'jetstack/cert-manager-csi-driver',
    port: 9402,
    workload: 'DaemonSet',
  }),
  // -- grafana ------------------------------------------------------------------
  chart({
    repo: 'grafana',
    chart: 'grafana',
    title: 'Grafana',
    description: 'The leading tool for querying and visualizing time series and metrics.',
    versions: [
      ['8.10.1', '11.5.1'],
      ['8.9.0', '11.5.0'],
      ['8.8.6', '11.4.0'],
      ['8.8.2', '11.4.0'],
      ['8.6.4', '11.3.1'],
      ['8.5.1', '11.2.0'],
      ['8.4.0', '11.1.0'],
    ],
    keywords: ['monitoring', 'metric'],
    home: 'https://grafana.com',
    source: 'https://github.com/grafana/grafana',
    image: 'grafana/grafana',
    port: 80,
    maintainers: [
      { name: 'zanhsieh', email: 'zanhsieh@gmail.com', url: null },
      { name: 'maorfr', email: 'maor.friedman@redhat.com', url: null },
      { name: 'Xtigyro', email: 'miroslav.hadzhiev@gmail.com', url: null },
    ],
    params: [
      ['adminUser', 'Grafana admin user', 'admin'],
      ['persistence.enabled', 'Use persistent storage for dashboards and plugins', false],
      ['datasources', 'Datasources to provision', {}],
      ['dashboardProviders', 'Dashboard providers to provision', {}],
      ['sidecar.dashboards.enabled', 'Load dashboards from labelled ConfigMaps', false],
    ],
    notes: 'grafana',
  }),
  chart({
    repo: 'grafana',
    chart: 'loki',
    title: 'Loki',
    description:
      'Helm chart for Grafana Loki and Grafana Enterprise Logs supporting monolithic, simple scalable, and microservices modes.',
    latest: '6.25.1',
    app: '3.4.2',
    keywords: ['logs', 'loki', 'grafana'],
    home: 'https://grafana.github.io/helm-charts',
    source: 'https://github.com/grafana/loki',
    image: 'grafana/loki',
    port: 3100,
    workload: 'StatefulSet',
    params: [
      [
        'deploymentMode',
        'Deployment mode: `SingleBinary`, `SimpleScalable` or `Distributed`',
        'SimpleScalable',
      ],
      ['loki.storage.type', 'Object storage backend', 's3'],
    ],
  }),
  chart({
    repo: 'grafana',
    chart: 'tempo',
    title: 'Tempo',
    description: 'Grafana Tempo Single Binary Mode',
    latest: '1.18.2',
    app: '2.7.0',
    keywords: ['tracing', 'tempo', 'grafana'],
    home: 'https://grafana.net',
    source: 'https://github.com/grafana/tempo',
    image: 'grafana/tempo',
    port: 3200,
    workload: 'StatefulSet',
  }),
  chart({
    repo: 'grafana',
    chart: 'mimir-distributed',
    title: 'Grafana Mimir',
    description: 'Grafana Mimir',
    latest: '5.6.0',
    app: '2.15.0',
    keywords: ['metrics', 'mimir', 'prometheus'],
    home: 'https://grafana.com/docs/helm-charts/mimir-distributed/latest/',
    source: 'https://github.com/grafana/mimir',
    image: 'grafana/mimir',
    port: 8080,
    workload: 'StatefulSet',
  }),
  chart({
    repo: 'grafana',
    chart: 'alloy',
    title: 'Grafana Alloy',
    description: 'Grafana Alloy',
    latest: '0.12.0',
    app: 'v1.6.1',
    keywords: ['alloy', 'opentelemetry', 'collector'],
    home: 'https://grafana.com/oss/alloy',
    source: 'https://github.com/grafana/alloy',
    image: 'grafana/alloy',
    port: 12345,
    workload: 'DaemonSet',
  }),
  chart({
    repo: 'grafana',
    chart: 'promtail',
    title: 'Promtail',
    description: 'Promtail is an agent which ships the contents of local logs to a Loki instance',
    latest: '6.16.6',
    app: '3.0.0',
    keywords: ['logs', 'promtail'],
    home: 'https://grafana.com/loki',
    source: 'https://github.com/grafana/loki',
    image: 'grafana/promtail',
    port: 3101,
    workload: 'DaemonSet',
    deprecated: true,
  }),
  // -- repositories that are not configured initially ---------------------------
  chart({
    repo: 'argo',
    chart: 'argo-cd',
    title: 'Argo CD',
    description:
      'A Helm chart for Argo CD, a declarative, GitOps continuous delivery tool for Kubernetes.',
    versions: [
      ['7.8.2', 'v2.14.2'],
      ['7.8.0', 'v2.14.0'],
      ['7.7.16', 'v2.13.4'],
      ['7.7.11', 'v2.13.3'],
      ['7.7.0', 'v2.13.0'],
      ['7.6.12', 'v2.12.6'],
    ],
    keywords: ['argoproj', 'argocd', 'gitops'],
    home: 'https://github.com/argoproj/argo-helm',
    source: 'https://github.com/argoproj/argo-helm/tree/main/charts/argo-cd',
    image: 'argoproj/argocd',
    port: 8080,
    kube: '>=1.25.0-0',
    deps: [
      {
        name: 'redis-ha',
        version: '4.29.4',
        repository: 'https://dandydeveloper.github.io/charts/',
        condition: 'redis-ha.enabled',
      },
    ],
  }),
  chart({
    repo: 'argo',
    chart: 'argo-rollouts',
    title: 'Argo Rollouts',
    description: 'A Helm chart for Argo Rollouts',
    latest: '2.38.2',
    app: 'v1.7.2',
    keywords: ['argoproj', 'argo-rollouts', 'progressive-delivery'],
    home: 'https://github.com/argoproj/argo-helm',
    image: 'argoproj/argo-rollouts',
    port: 8090,
  }),
  chart({
    repo: 'argo',
    chart: 'argo-workflows',
    title: 'Argo Workflows',
    description: 'A Helm chart for Argo Workflows',
    latest: '0.45.6',
    app: 'v3.6.4',
    keywords: ['argoproj', 'argo', 'workflows'],
    home: 'https://github.com/argoproj/argo-helm',
    image: 'argoproj/workflow-controller',
    port: 2746,
  }),
  chart({
    repo: 'traefik',
    chart: 'traefik',
    title: 'Traefik Proxy',
    description: 'A Traefik based Kubernetes ingress controller',
    latest: '34.3.0',
    app: 'v3.3.3',
    keywords: ['traefik', 'ingress', 'networking'],
    home: 'https://traefik.io/',
    source: 'https://github.com/traefik/traefik-helm-chart',
    image: 'traefik',
    port: 80,
  }),
  chart({
    repo: 'hashicorp',
    chart: 'vault',
    title: 'Vault',
    description: 'Official HashiCorp Vault Chart',
    latest: '0.29.1',
    app: '1.18.1',
    keywords: [
      'vault',
      'security',
      'encryption',
      'secrets',
      'management',
      'automation',
      'infrastructure',
    ],
    home: 'https://www.vaultproject.io',
    source: 'https://github.com/hashicorp/vault-helm',
    image: 'hashicorp/vault',
    port: 8200,
    workload: 'StatefulSet',
  }),
  chart({
    repo: 'kedacore',
    chart: 'keda',
    title: 'KEDA',
    description: 'Event-based autoscaler for workloads on Kubernetes',
    latest: '2.16.1',
    app: '2.16.1',
    keywords: ['autoscaling', 'event-driven', 'serverless'],
    home: 'https://github.com/kedacore/keda',
    image: 'kedacore/keda',
    port: 8080,
  }),
  chart({
    repo: 'external-secrets',
    chart: 'external-secrets',
    title: 'External Secrets Operator',
    description: 'External secret management for Kubernetes',
    latest: '0.14.2',
    app: 'v0.14.2',
    keywords: ['kubernetes-external-secrets', 'secrets', 'vault', 'aws-secrets-manager'],
    home: 'https://github.com/external-secrets/external-secrets',
    image: 'external-secrets/external-secrets',
    port: 8080,
  }),
  chart({
    repo: 'cilium',
    chart: 'cilium',
    title: 'Cilium',
    description: 'eBPF-based Networking, Security, and Observability',
    latest: '1.17.1',
    app: '1.17.1',
    keywords: ['BPF', 'eBPF', 'Kubernetes', 'Networking', 'Security', 'Observability'],
    home: 'https://cilium.io/',
    source: 'https://github.com/cilium/cilium',
    image: 'cilium/cilium',
    port: 4244,
    workload: 'DaemonSet',
  }),
  chart({
    repo: 'kyverno',
    chart: 'kyverno',
    title: 'Kyverno',
    description: 'Kubernetes Native Policy Management',
    latest: '3.3.5',
    app: 'v1.13.3',
    keywords: [
      'kubernetes',
      'nirmata',
      'policy agent',
      'policy',
      'validating webhook',
      'admission controller',
    ],
    home: 'https://kyverno.io/',
    source: 'https://github.com/kyverno/kyverno',
    image: 'kyverno/kyverno',
    port: 9443,
  }),
  chart({
    repo: 'open-telemetry',
    chart: 'opentelemetry-collector',
    title: 'OpenTelemetry Collector',
    description: 'OpenTelemetry Collector Helm chart for Kubernetes',
    latest: '0.117.0',
    app: '0.119.0',
    keywords: ['opentelemetry', 'collector', 'tracing', 'metrics', 'logs'],
    home: 'https://opentelemetry.io/',
    source: 'https://github.com/open-telemetry/opentelemetry-collector',
    image: 'otel/opentelemetry-collector-k8s',
    port: 4317,
  }),
  chart({
    repo: 'acme',
    chart: 'acme-service',
    title: 'ACME service',
    description: 'Golden-path chart for ACME HTTP services (Deployment, Service, HPA, dashboards).',
    versions: [
      ['1.10.0', '2.15.0'],
      ['1.9.4', '2.14.3'],
      ['1.9.2', '2.14.0'],
      ['1.8.0', '2.12.0'],
    ],
    keywords: ['acme', 'service', 'golden-path'],
    home: 'https://backstage.acme.io/docs/charts/acme-service',
    source: 'https://git.acme.io/platform/charts',
    image: 'ghcr.io/acme/service',
    port: 8080,
    maintainers: [{ name: 'Platform team', email: 'platform@acme.io', url: null }],
    params: [
      ['autoscaling.enabled', 'Create a HorizontalPodAutoscaler', false],
      ['autoscaling.minReplicas', 'Minimum replicas', 2],
      ['autoscaling.maxReplicas', 'Maximum replicas', 10],
      ['envFrom', 'Environment sources (ConfigMaps / Secrets)', []],
    ],
  }),
];

export function chartDef(repo: string, name: string): ChartDef | undefined {
  return CHARTS.find((c) => c.repo === repo && c.chart === name);
}

// ---------------------------------------------------------------------------
// Values & README
// ---------------------------------------------------------------------------

function setPath(target: Record<string, unknown>, path: string[], value: unknown) {
  let node = target;
  path.slice(0, -1).forEach((key) => {
    if (typeof node[key] !== 'object' || node[key] === null || Array.isArray(node[key]))
      node[key] = {};
    node = node[key] as Record<string, unknown>;
  });
  node[path[path.length - 1]!] = structuredClone(value);
}

/** Default values of one chart version as nested data. */
export function defaultValues(c: ChartDef, version: string): Record<string, unknown> {
  const app = c.versions.find(([v]) => v === version)?.[1] ?? c.versions[0]![1];
  const root: Record<string, unknown> = {};
  for (const [path, , value] of c.params)
    setPath(root, path.split('.'), path === 'image.tag' ? app.replace(/^v/, '') : value);
  return root;
}

/** `values.yaml` with bitnami-style `## @param` comments. */
export function valuesYaml(c: ChartDef, version: string): string {
  const doc = new YAML.Document(defaultValues(c, version));
  for (const [path, description] of c.params) {
    let node: unknown = doc.contents;
    const keys = path.split('.');
    keys.forEach((key, i) => {
      if (!YAML.isMap(node)) return;
      const pair = node.items.find((p) => YAML.isScalar(p.key) && p.key.value === key);
      if (!pair) return;
      if (i === keys.length - 1 && YAML.isScalar(pair.key))
        pair.key.commentBefore = `# @param ${path} ${description.replace(/`/g, '')}`;
      node = pair.value;
    });
  }
  doc.commentBefore = `# Copyright ${c.repo === 'bitnami' ? 'Broadcom, Inc. All Rights Reserved.' : c.title + ' authors'}\n# SPDX-License-Identifier: APACHE-2.0\n\n# Default values for ${c.chart}.\n# This is a YAML-formatted file.\n# Declare variables to be passed into your templates.`;
  return doc.toString({ lineWidth: 0 });
}

function valueCell(value: unknown): string {
  if (typeof value === 'string') return `\`"${value}"\``;
  return `\`${JSON.stringify(value)}\``;
}

export function readme(c: ChartDef, repoUrl: string): string {
  const [latest] = c.versions[0]!;
  const major = latest.replace(/^v/, '').split('.')[0];
  const stateful = c.workload === 'StatefulSet';
  const groups = new Map<string, Param[]>();
  for (const p of c.params) {
    const head =
      p[0].startsWith('global.') || p[0].endsWith('Override')
        ? 'Global parameters'
        : p[0].startsWith('image.') || p[0] === 'replicaCount'
          ? `${c.title} parameters`
          : p[0].startsWith('service.') || p[0].startsWith('ingress.')
            ? 'Traffic exposure parameters'
            : p[0].startsWith('persistence.')
              ? 'Persistence parameters'
              : p[0].startsWith('metrics.')
                ? 'Metrics parameters'
                : 'Other parameters';
    groups.set(head, [...(groups.get(head) ?? []), p]);
  }
  const tables = [...groups.entries()]
    .map(
      ([head, params]) =>
        `### ${head}\n\n| Name | Description | Value |\n| ---- | ----------- | ----- |\n${params
          .map(
            ([path, description, value]) =>
              `| \`${path}\` | ${description} | ${valueCell(value)} |`,
          )
          .join('\n')}`,
    )
    .join('\n\n');
  return `<!--- app-name: ${c.title} -->

# ${c.title}${c.repo === 'bitnami' ? ' packaged by Bitnami' : ''}

${c.description.replace(/^DEPRECATED /, '')}

[Overview of ${c.title}](${c.home})

[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/${c.repo})](https://artifacthub.io/packages/helm/${c.repo}/${c.chart})
${c.deprecated ? `\n> **Deprecated**: this chart is no longer maintained and will not receive updates. See the repository for a migration guide.\n` : ''}
## TL;DR

\`\`\`console
helm install my-release ${c.repo}/${c.chart}
\`\`\`

## Introduction

This chart bootstraps a [${c.title}](${c.home}) ${c.workload} on a [Kubernetes](https://kubernetes.io) cluster using the [Helm](https://helm.sh) package manager.

> **Tip**: List all releases using \`helm list\`

## Prerequisites

- Kubernetes 1.23+
- Helm 3.8.0+${stateful ? '\n- PV provisioner support in the underlying infrastructure' : ''}

## Installing the Chart

To install the chart with the release name \`my-release\`:

\`\`\`console
helm repo add ${c.repo} ${repoUrl}
helm install my-release ${c.repo}/${c.chart}
\`\`\`

The command deploys ${c.title} on the Kubernetes cluster in the default configuration. The [Parameters](#parameters) section lists the parameters that can be configured during installation.

## Configuration and installation details

### Resource requests and limits

Resource requests and limits are **strongly recommended** for production workloads. The chart ships _conservative_ defaults under \`resources\`; adjust them to your workload, for example:

\`\`\`yaml
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    memory: 1Gi
\`\`\`

### Exposing the service

1. Through a \`LoadBalancer\` service:
   - set \`service.type=LoadBalancer\`
   - optionally pin the address with \`service.loadBalancerIP\`
2. Through an Ingress:
   - set \`ingress.enabled=true\`
   - set \`ingress.hostname\` to your domain
     1. add \`ingress.tls=true\` to terminate TLS
     2. let [cert-manager](https://cert-manager.io) issue the certificate
3. For local testing, use \`kubectl port-forward\` (see the release notes).

${c.details ?? ''}
## Parameters

${tables}

Specify each parameter using the \`--set key=value[,key=value]\` argument to \`helm install\`. For example,

\`\`\`console
helm install my-release --set replicaCount=3 ${c.repo}/${c.chart}
\`\`\`

Alternatively, a YAML file that specifies the values for the parameters can be provided while installing the chart:

\`\`\`console
helm install my-release -f values.yaml ${c.repo}/${c.chart}
\`\`\`

## Troubleshooting

Find more information about how to deal with common errors related to Helm charts in the [troubleshooting guide](https://docs.bitnami.com/general/how-to/troubleshoot-helm-chart-issues).

## Upgrading

### To ${major}.0.0

This major release renames several values and bumps the minimum Kubernetes version:

- \`podAnnotations\` moved under \`${c.workload === 'DaemonSet' ? 'daemonset' : 'deployment'}.podAnnotations\`
- ~~\`securityContext.enabled\`~~ was removed; use \`podSecurityContext.enabled\` instead
- The default \`image.pullPolicy\` is now \`IfNotPresent\`

***

## License

Copyright &copy; 2025 ${c.repo === 'bitnami' ? 'Broadcom, Inc. All Rights Reserved.' : `${c.title} authors`}

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

<http://www.apache.org/licenses/LICENSE-2.0>

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
`;
}

// ---------------------------------------------------------------------------
// Rendering (what the demo install / upgrade "deploys")
// ---------------------------------------------------------------------------

function fullname(release: string, chartName: string) {
  return (release.includes(chartName) ? release : `${release}-${chartName}`).slice(0, 63);
}

function get(values: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
      values,
    );
}

export function renderManifest(
  c: ChartDef,
  version: string,
  release: string,
  namespace: string,
  values: Record<string, unknown>,
): string {
  const name = fullname(release, c.chart);
  const app = c.versions.find(([v]) => v === version)?.[1] ?? c.versions[0]![1];
  const labels = {
    'app.kubernetes.io/name': c.chart,
    'app.kubernetes.io/instance': release,
    'app.kubernetes.io/version': app,
    'app.kubernetes.io/managed-by': 'Helm',
    'helm.sh/chart': `${c.chart}-${version}`,
  };
  const selector = { 'app.kubernetes.io/name': c.chart, 'app.kubernetes.io/instance': release };
  const port = Number(get(values, 'service.port') ?? c.port) || c.port;
  const registry = String(get(values, 'image.registry') ?? 'docker.io');
  const image = `${registry}/${String(get(values, 'image.repository') ?? c.image)}:${String(
    get(values, 'image.tag') ?? app,
  )}`;
  const resources = get(values, 'resources') ?? {};
  const docs: Array<[string, Record<string, unknown>]> = [
    [
      'serviceaccount.yaml',
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name, namespace, labels },
        automountServiceAccountToken: false,
      },
    ],
    [
      'configmap.yaml',
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: `${name}-config`, namespace, labels },
        data: { 'app.conf': `# ${c.title} ${app}\nlisten ${port}\n` },
      },
    ],
    [
      'service.yaml',
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace, labels },
        spec: {
          type: String(get(values, 'service.type') ?? 'ClusterIP'),
          ports: [{ name: 'http', port, targetPort: 'http', protocol: 'TCP' }],
          selector,
        },
      },
    ],
  ];
  const podSpec = {
    serviceAccountName: name,
    securityContext: get(values, 'podSecurityContext.enabled')
      ? { fsGroup: get(values, 'podSecurityContext.fsGroup') ?? 1001 }
      : {},
    containers: [
      {
        name: c.chart,
        image,
        imagePullPolicy: String(get(values, 'image.pullPolicy') ?? 'IfNotPresent'),
        ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
        resources,
        readinessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 5, periodSeconds: 10 },
      },
    ],
    nodeSelector: get(values, 'nodeSelector') ?? {},
    tolerations: get(values, 'tolerations') ?? [],
  };
  const template = { metadata: { labels }, spec: podSpec };
  const workload: Record<string, unknown> = {
    apiVersion: 'apps/v1',
    kind: c.workload,
    metadata: { name, namespace, labels },
    spec:
      c.workload === 'DaemonSet'
        ? { selector: { matchLabels: selector }, template }
        : {
            replicas: Number(get(values, 'replicaCount') ?? 1),
            selector: { matchLabels: selector },
            ...(c.workload === 'StatefulSet' ? { serviceName: `${name}-headless` } : {}),
            template,
          },
  };
  docs.push([`${c.workload.toLowerCase()}.yaml`, workload]);
  if (c.workload === 'StatefulSet')
    docs.push([
      'service-headless.yaml',
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: `${name}-headless`, namespace, labels },
        spec: { clusterIP: 'None', ports: [{ name: 'http', port }], selector },
      },
    ]);
  if (get(values, 'ingress.enabled'))
    docs.push([
      'ingress.yaml',
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: { name, namespace, labels },
        spec: {
          ingressClassName: String(get(values, 'ingress.ingressClassName') || 'nginx'),
          rules: [
            {
              host: String(get(values, 'ingress.hostname') ?? `${c.chart}.local`),
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: { service: { name, port: { name: 'http' } } },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
  return docs
    .map(
      ([file, doc]) =>
        `---\n# Source: ${c.chart}/templates/${file}\n${YAML.stringify(doc, { lineWidth: 0 })}`,
    )
    .join('');
}

export function renderNotes(c: ChartDef, version: string, release: string, namespace: string) {
  const name = fullname(release, c.chart);
  const app = c.versions.find(([v]) => v === version)?.[1] ?? c.versions[0]![1];
  switch (c.notes) {
    case 'ingress':
      return `The ingress-nginx controller has been installed.\nIt may take a few minutes for the load balancer IP to be available.\nYou can watch the status by running 'kubectl get service --namespace ${namespace} ${name}-controller --output wide --watch'\n\nAn example Ingress that makes use of the controller:\n  apiVersion: networking.k8s.io/v1\n  kind: Ingress\n  metadata:\n    name: example\n    namespace: foo\n  spec:\n    ingressClassName: nginx\n    rules:\n      - host: www.example.com\n`;
    case 'certmanager':
      return `cert-manager ${version} has been deployed successfully!\n\nIn order to begin issuing certificates, you will need to set up a ClusterIssuer\nor Issuer resource (for example, by creating a 'letsencrypt-staging' issuer).\n\nMore information on the different types of issuers and how to configure them\ncan be found in our documentation:\n\nhttps://cert-manager.io/docs/configuration/\n`;
    case 'grafana':
      return `1. Get your 'admin' user password by running:\n\n   kubectl get secret --namespace ${namespace} ${name} -o jsonpath="{.data.admin-password}" | base64 --decode ; echo\n\n2. The Grafana server can be accessed via port 80 on the following DNS name from within your cluster:\n\n   ${name}.${namespace}.svc.cluster.local\n\n3. Login with the password from step 1 and the username: admin\n`;
    default:
      return `CHART NAME: ${c.chart}\nCHART VERSION: ${version}\nAPP VERSION: ${app}\n\n** Please be patient while the chart is being deployed **\n\n${c.title} can be accessed through the following DNS name from within your cluster:\n\n    ${name}.${namespace}.svc.cluster.local (port ${c.port})\n\nTo access ${c.title} from outside the cluster execute the following commands:\n\n    kubectl port-forward --namespace ${namespace} svc/${name} ${c.port}:${c.port} &\n    echo "URL: http://127.0.0.1:${c.port}/"\n`;
  }
}
