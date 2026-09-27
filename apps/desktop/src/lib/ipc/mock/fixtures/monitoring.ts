import type { ClusterDb } from './db';
import { buildDaemonSet, buildDeployment, buildStatefulSet } from './builders';
import { buildService } from './network';
import { tpl, cfg } from './template';
import { DAY } from './util';

/** Monitoring namespace: Prometheus, Grafana, Loki, exporters and log shippers. */

export function buildMonitoring(db: ClusterDb) {
  const p = db.profile;
  const ns = 'monitoring';
  const small = p.platform === 'kind';
  if (!small) {
    buildDaemonSet(db, {
      namespace: ns,
      name: 'node-exporter',
      age: 120 * DAY,
      template: tpl(
        'node-exporter',
        [
          {
            name: 'node-exporter',
            image: 'quay.io/prometheus/node-exporter:v1.8.2',
            ports: [9100],
            cpu: ['10m', '200m'],
            mem: ['32Mi', '64Mi'],
            args: [
              '--path.procfs=/host/proc',
              '--path.sysfs=/host/sys',
              '--path.rootfs=/host/root',
            ],
            probe: 'http',
            probePath: '/',
          },
        ],
        { hostNetwork: true, sa: 'node-exporter' },
      ),
    });
    buildDaemonSet(db, {
      namespace: ns,
      name: 'fluent-bit',
      age: 110 * DAY,
      template: tpl(
        'fluent-bit',
        [
          {
            name: 'fluent-bit',
            image: 'cr.fluentbit.io/fluent/fluent-bit:3.2.4',
            ports: [{ name: 'http', port: 2020 }],
            cpu: ['50m', '500m'],
            mem: ['64Mi', '256Mi'],
            mounts: [
              ['config', '/fluent-bit/etc/conf'],
              ['varlog', '/var/log', true],
            ],
            probe: 'http',
            probePath: '/',
          },
        ],
        {
          sa: 'fluent-bit',
          volumes: [
            cfg('fluent-bit'),
            { name: 'varlog', hostPath: { path: '/var/log', type: '' } },
          ],
        },
      ),
    });
    buildDeployment(db, {
      namespace: ns,
      name: 'prometheus-server',
      age: 120 * DAY,
      replicas: 1,
      oldRevisions: 4,
      template: tpl(
        'prometheus-server',
        [
          {
            name: 'prometheus-server',
            image: 'quay.io/prometheus/prometheus:v3.1.0',
            ports: [9090],
            cpu: ['500m', '2'],
            mem: ['2Gi', '4Gi'],
            probe: 'http',
            probePath: '/-/healthy',
            args: [
              '--storage.tsdb.retention.time=15d',
              '--config.file=/etc/config/prometheus.yml',
              '--storage.tsdb.path=/data',
            ],
            mounts: [
              ['config-volume', '/etc/config'],
              ['storage-volume', '/data'],
            ],
          },
          {
            name: 'config-reloader',
            image: 'quay.io/prometheus-operator/prometheus-config-reloader:v0.79.2',
            cpu: ['10m'],
            mem: ['25Mi', '50Mi'],
          },
        ],
        {
          sa: 'prometheus-server',
          volumes: [
            cfg('prometheus-server'),
            { name: 'storage-volume', persistentVolumeClaim: { claimName: 'prometheus-server' } },
          ],
        },
      ),
    });
    buildDeployment(db, {
      namespace: ns,
      name: 'kube-state-metrics',
      age: 120 * DAY,
      replicas: 1,
      template: tpl(
        'kube-state-metrics',
        [
          {
            name: 'kube-state-metrics',
            image: 'registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.14.0',
            ports: [8080, { name: 'telemetry', port: 8081 }],
            cpu: ['10m', '100m'],
            mem: ['64Mi', '256Mi'],
            probe: 'http',
            probePath: '/livez',
          },
        ],
        { sa: 'kube-state-metrics' },
      ),
    });
    buildStatefulSet(db, {
      namespace: ns,
      name: 'loki',
      serviceName: 'loki-headless',
      age: 45 * DAY,
      replicas: 1,
      storage: '20Gi',
      variants: p.troubled ? { 0: 'creating' } : {},
      template: tpl(
        'loki',
        [
          {
            name: 'loki',
            image: 'docker.io/grafana/loki:3.3.2',
            ports: [
              { name: 'http-metrics', port: 3100 },
              { name: 'grpc', port: 9095 },
            ],
            cpu: ['100m'],
            mem: ['256Mi', '1Gi'],
            probe: 'http',
            probePath: '/ready',
            mounts: [
              ['config', '/etc/loki/config'],
              ['storage', '/var/loki'],
            ],
          },
        ],
        {
          sa: 'loki',
          volumes: [
            cfg('loki'),
            { name: 'storage', persistentVolumeClaim: { claimName: 'storage-loki-0' } },
          ],
        },
      ),
    });
    buildStatefulSet(db, {
      namespace: ns,
      name: 'alertmanager',
      serviceName: 'alertmanager-headless',
      age: 120 * DAY,
      replicas: 1,
      storage: '2Gi',
      template: tpl(
        'alertmanager',
        [
          {
            name: 'alertmanager',
            image: 'quay.io/prometheus/alertmanager:v0.28.0',
            ports: [9093],
            cpu: ['10m', '100m'],
            mem: ['32Mi', '128Mi'],
            probe: 'http',
            probePath: '/-/healthy',
          },
        ],
        { sa: 'alertmanager' },
      ),
    });
    buildService(db, {
      namespace: ns,
      name: 'prometheus-server',
      selector: { app: 'prometheus-server' },
      ports: [{ name: 'http', port: 80, targetPort: 9090 }],
    });
    buildService(db, {
      namespace: ns,
      name: 'kube-state-metrics',
      selector: { app: 'kube-state-metrics' },
      ports: [{ name: 'http', port: 8080 }],
    });
    buildService(db, {
      namespace: ns,
      name: 'loki',
      selector: { app: 'loki' },
      ports: [
        { name: 'http-metrics', port: 3100 },
        { name: 'grpc', port: 9095 },
      ],
    });
    buildService(db, {
      namespace: ns,
      name: 'loki-headless',
      type: 'Headless',
      selector: { app: 'loki' },
      ports: [{ name: 'http-metrics', port: 3100 }],
    });
    buildService(db, {
      namespace: ns,
      name: 'alertmanager',
      selector: { app: 'alertmanager' },
      ports: [{ name: 'http', port: 9093 }],
    });
    buildService(db, {
      namespace: ns,
      name: 'alertmanager-headless',
      type: 'Headless',
      selector: { app: 'alertmanager' },
      ports: [{ name: 'http', port: 9093 }],
    });
    buildService(db, {
      namespace: ns,
      name: 'node-exporter',
      selector: { app: 'node-exporter' },
      ports: [{ name: 'metrics', port: 9100 }],
    });
  }
  buildDeployment(db, {
    namespace: ns,
    name: 'grafana',
    age: 120 * DAY,
    replicas: 1,
    oldRevisions: 6,
    template: tpl(
      'grafana',
      [
        {
          name: 'grafana',
          image: 'docker.io/grafana/grafana:11.4.0',
          ports: [3000],
          cpu: ['100m', '500m'],
          mem: ['128Mi', '512Mi'],
          probe: 'http',
          probePath: '/api/health',
          env: [
            ['GF_SECURITY_ADMIN_USER', { secret: ['grafana', 'admin-user'] }],
            ['GF_SECURITY_ADMIN_PASSWORD', { secret: ['grafana', 'admin-password'] }],
            ['GF_PATHS_DATA', '/var/lib/grafana/'],
          ],
          mounts: [
            ['config', '/etc/grafana/grafana.ini'],
            ['storage', '/var/lib/grafana'],
          ],
        },
        {
          name: 'grafana-sc-dashboard',
          image: 'quay.io/kiwigrid/k8s-sidecar:1.28.0',
          cpu: ['10m'],
          mem: ['32Mi', '96Mi'],
          env: [
            ['LABEL', 'grafana_dashboard'],
            ['FOLDER', '/tmp/dashboards'],
          ],
        },
      ],
      {
        sa: 'grafana',
        volumes: [
          cfg('grafana'),
          { name: 'storage', persistentVolumeClaim: { claimName: 'grafana' } },
        ],
      },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'grafana',
    type: small ? 'NodePort' : 'ClusterIP',
    selector: { app: 'grafana' },
    ports: [{ name: 'service', port: 80, targetPort: 3000, nodePort: 30300 }],
  });
}
