import {
  ADMISSION_CA,
  DEMO_TLS_KEY,
  GRAFANA_LEAF,
  KUBE_ROOT_CA,
  STOREFRONT_LEAF,
  WEBHOOK_CA,
  issuerCa,
  stamped,
} from './certs';
import { list, put, type ClusterDb } from './db';
import { namespacesFor } from './infra';
import { b64, between, DAY, meta, obj } from './util';

/** ConfigMaps, Secrets and ServiceAccounts. */

function cm(
  db: ClusterDb,
  namespace: string,
  name: string,
  data: Record<string, string>,
  age = 90 * DAY,
  labels?: Record<string, string>,
) {
  put(db, obj('v1', 'ConfigMap', meta({ name, namespace, age, labels }), { data }));
}

function secret(
  db: ClusterDb,
  namespace: string,
  name: string,
  type: string,
  data: Record<string, string>,
  age = 90 * DAY,
  labels?: Record<string, string>,
) {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) encoded[k] = b64(v);
  put(db, obj('v1', 'Secret', meta({ name, namespace, age, labels }), { type, data: encoded }));
}

export function buildConfig(db: ClusterDb) {
  const p = db.profile;
  const rootCa = stamped(KUBE_ROOT_CA, 420, 3230);
  for (const ns of namespacesFor(db)) {
    cm(db, ns, 'kube-root-ca.crt', { 'ca.crt': rootCa }, 200 * DAY);
    put(db, obj('v1', 'ServiceAccount', meta({ name: 'default', namespace: ns, age: 200 * DAY })));
  }
  // Service accounts referenced by pod templates.
  const seen = new Set<string>();
  for (const pod of list(db, 'pods')) {
    const sa = String(pod.spec?.serviceAccountName ?? 'default');
    const key = `${pod.metadata.namespace}/${sa}`;
    if (sa === 'default' || seen.has(key)) continue;
    seen.add(key);
    put(
      db,
      obj(
        'v1',
        'ServiceAccount',
        meta({
          name: sa,
          namespace: pod.metadata.namespace,
          age: 150 * DAY,
          labels: { 'app.kubernetes.io/name': sa },
          annotations:
            p.platform === 'EKS' &&
            ['payment-api', 'ebs-csi-controller-sa', 'cluster-autoscaler'].includes(sa)
              ? { 'eks.amazonaws.com/role-arn': `arn:aws:iam::123456789012:role/${p.id}-${sa}` }
              : {},
        }),
        {
          automountServiceAccountToken: sa !== 'payment-api',
        },
      ),
    );
  }

  cm(
    db,
    'kube-system',
    'coredns',
    {
      Corefile: `.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n`,
    },
    200 * DAY,
  );
  cm(db, 'checkout', 'payment-api-config', {
    'application.yaml': `server:\n  port: 8080\n  shutdown: graceful\npayments:\n  provider: stripe\n  currency: EUR\n  retry:\n    max-attempts: 3\n    backoff: 250ms\nmanagement:\n  endpoints:\n    web:\n      exposure:\n        include: health,prometheus\n`,
    'feature-flags': 'apple-pay=true,klarna=false,3ds2=true',
    'log-level': 'INFO',
    'rate-limits.json': `{\n  "default": { "rps": 50, "burst": 100 },\n  "routes": {\n    "/v1/charges": { "rps": 20, "burst": 40 },\n    "/v1/refunds": { "rps": 5, "burst": 10 }\n  }\n}\n`,
  });
  cm(db, 'web', 'storefront-nginx', {
    'default.conf': `server {\n  listen 80;\n  location / {\n    proxy_pass http://127.0.0.1:3000;\n    proxy_set_header Host $host;\n  }\n  location /healthz { return 200 'ok'; }\n}\n`,
  });
  if (p.platform !== 'kind') {
    cm(db, 'monitoring', 'prometheus-server', {
      'prometheus.yml': `global:\n  scrape_interval: 30s\n  evaluation_interval: 30s\nrule_files:\n  - /etc/config/recording_rules.yml\n  - /etc/config/alerting_rules.yml\nscrape_configs:\n  - job_name: kubernetes-pods\n    kubernetes_sd_configs:\n      - role: pod\n    relabel_configs:\n      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]\n        action: keep\n        regex: true\n`,
      'alerting_rules.yml': `groups:\n  - name: kubernetes\n    rules:\n      - alert: KubePodCrashLooping\n        expr: rate(kube_pod_container_status_restarts_total[5m]) > 0\n        for: 15m\n`,
      'recording_rules.yml': '{}\n',
    });
    cm(db, 'monitoring', 'fluent-bit', {
      'fluent-bit.conf': `[SERVICE]\n    Flush 1\n    Log_Level info\n[INPUT]\n    Name tail\n    Path /var/log/containers/*.log\n    multiline.parser docker, cri\n[OUTPUT]\n    Name loki\n    Match *\n    Host loki.monitoring\n`,
    });
    cm(db, 'monitoring', 'loki', {
      'config.yaml': `auth_enabled: false\nserver:\n  http_listen_port: 3100\ncommon:\n  path_prefix: /var/loki\n  replication_factor: 1\nschema_config:\n  configs:\n    - from: "2024-04-01"\n      store: tsdb\n      object_store: filesystem\n      schema: v13\n`,
    });
  }
  cm(db, 'monitoring', 'grafana', {
    'grafana.ini': `[server]\nroot_url = https://grafana.${p.domain}\n[auth.anonymous]\nenabled = false\n[analytics]\nreporting_enabled = false\n`,
  });
  cm(db, 'ingress-nginx', 'ingress-nginx-controller', {
    'allow-snippet-annotations': 'false',
    'use-forwarded-headers': 'true',
    'proxy-body-size': '16m',
    'enable-real-ip': 'true',
  });
  if (p.platform === 'kind')
    cm(db, 'local-path-storage', 'local-path-config', {
      'config.json':
        '{\n  "nodePathMap": [{ "node": "DEFAULT_PATH_FOR_NON_LISTED_NODES", "paths": ["/var/local-path-provisioner"] }]\n}\n',
    });

  secret(db, 'checkout', 'payment-api-secrets', 'Opaque', {
    DATABASE_URL:
      'postgres://app:demo-password@postgres.data.svc.cluster.local:5432/payments?sslmode=require',
    STRIPE_API_KEY: 'sk_demo_kubepit_not_a_real_key_4eC39HqLyjWDarjtT1zdp7dc',
    WEBHOOK_SIGNING_SECRET: 'whsec_demo_only_1234567890',
  });
  secret(db, 'web', 'storefront-secrets', 'Opaque', {
    SESSION_SECRET: 'demo-session-secret-rotate-me',
    ANALYTICS_TOKEN: 'demo-analytics-token',
  });
  secret(db, 'data', 'postgres-credentials', 'Opaque', {
    username: 'app',
    password: 'demo-password',
    'postgres-password': 'demo-superuser-password',
  });
  secret(db, 'monitoring', 'grafana', 'Opaque', {
    'admin-user': 'admin',
    'admin-password': 'demo-grafana-password',
    'ldap-toml': '',
  });
  // Real certificates (see certs.ts); on troubled clusters Grafana's renewal is stuck and
  // its certificate expires in 12 days (its cert-manager Certificate is not Ready).
  const issuer = issuerCa();
  secret(
    db,
    'web',
    'storefront-tls',
    'kubernetes.io/tls',
    { 'tls.crt': stamped(STOREFRONT_LEAF, 20, 70) + issuer, 'tls.key': DEMO_TLS_KEY },
    20 * DAY,
    { 'controller.cert-manager.io/fao': 'true' },
  );
  secret(
    db,
    'monitoring',
    'grafana-tls',
    'kubernetes.io/tls',
    {
      'tls.crt':
        (p.troubled ? stamped(GRAFANA_LEAF, 77.5, 12.5) : stamped(GRAFANA_LEAF, 20, 70)) + issuer,
      'tls.key': DEMO_TLS_KEY,
    },
    p.troubled ? 78 * DAY : 20 * DAY,
    { 'controller.cert-manager.io/fao': 'true' },
  );
  const webhookCa = stamped(WEBHOOK_CA, 140, 225);
  secret(db, 'cert-manager', 'cert-manager-webhook-ca', 'Opaque', {
    'ca.crt': webhookCa,
    'tls.crt': webhookCa,
    'tls.key': DEMO_TLS_KEY,
  });
  const admission = stamped(ADMISSION_CA, 300, 3350);
  secret(db, 'ingress-nginx', 'ingress-nginx-admission', 'Opaque', {
    ca: admission,
    cert: admission,
    key: DEMO_TLS_KEY,
  });
  for (const ns of ['checkout', 'web', 'data']) {
    secret(
      db,
      ns,
      'ghcr-pull',
      'kubernetes.io/dockerconfigjson',
      {
        '.dockerconfigjson': JSON.stringify({
          auths: { 'ghcr.io': { username: 'acme-bot', auth: b64('acme-bot:demo-token') } },
        }),
      },
      120 * DAY,
    );
  }
  if (p.argocd) {
    secret(
      db,
      'argocd',
      'argocd-initial-admin-secret',
      'Opaque',
      { password: 'demo-argocd-password' },
      100 * DAY,
    );
    secret(
      db,
      'argocd',
      'repo-acme-gitops',
      'Opaque',
      {
        type: 'git',
        url: 'https://github.com/acme/gitops.git',
        username: 'acme-bot',
        password: 'demo-token',
      },
      100 * DAY,
      { 'argocd.argoproj.io/secret-type': 'repository' },
    );
    cm(
      db,
      'argocd',
      'argocd-cm',
      {
        url: `https://argocd.${p.domain}`,
        'timeout.reconciliation': '180s',
        'admin.enabled': 'true',
      },
      100 * DAY,
    );
  }
  for (const team of p.teams)
    cm(
      db,
      `team-${team}`,
      `${team}-settings`,
      {
        LOG_LEVEL: 'info',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector.monitoring:4317',
        TEAM: team,
      },
      between(db.rand, 20, 200) * DAY,
    );
}
