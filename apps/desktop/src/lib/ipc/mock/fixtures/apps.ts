import type { ClusterDb } from './db';
import { buildDeployment } from './builders';
import { buildIngress, buildService } from './network';
import { tpl } from './template';
import { DAY, MIN } from './util';

/** Business workloads: checkout and web namespaces. */

export function buildCheckout(db: ClusterDb) {
  const p = db.profile;
  const ns = 'checkout';
  const small = p.platform === 'kind';
  buildDeployment(db, {
    namespace: ns,
    name: 'payment-api',
    age: 140 * DAY,
    replicas: small ? 2 : 3,
    rsHash: '7c9d8b6f5',
    podNames: ['h8zqd', 'x2kqp', 'pl4tw'],
    variants: p.troubled ? { 1: 'crashloop' } : {},
    restarts: { 0: 1 },
    oldRevisions: 11,
    labels: { team: 'payments', tier: 'backend' },
    template: tpl(
      'payment-api',
      [
        {
          name: 'payment-api',
          image: 'ghcr.io/acme/payment-api:2.14.3',
          ports: [8080, { name: 'metrics', port: 9090 }],
          cpu: ['250m', '1'],
          mem: ['512Mi', '1Gi'],
          probe: 'http',
          env: [
            ['SPRING_PROFILES_ACTIVE', p.id.includes('prod') ? 'production' : 'staging'],
            ['DATABASE_URL', { secret: ['payment-api-secrets', 'DATABASE_URL'] }],
            ['STRIPE_API_KEY', { secret: ['payment-api-secrets', 'STRIPE_API_KEY'] }],
            ['FEATURE_FLAGS', { config: ['payment-api-config', 'feature-flags'] }],
            ['POD_IP', { field: 'status.podIP' }],
          ],
          mounts: [
            ['config', '/etc/payment-api', true],
            ['tmp', '/tmp'],
          ],
        },
        {
          name: 'envoy',
          image: 'docker.io/envoyproxy/envoy:v1.32.3',
          ports: [{ name: 'admin', port: 9901 }],
          cpu: ['50m', '200m'],
          mem: ['64Mi', '128Mi'],
        },
      ],
      {
        sa: 'payment-api',
        init: [
          {
            name: 'migrate',
            image: 'ghcr.io/acme/payment-api:2.14.3',
            command: ['./bin/migrate', 'up'],
            env: [['DATABASE_URL', { secret: ['payment-api-secrets', 'DATABASE_URL'] }]],
            cpu: ['100m'],
            mem: ['128Mi'],
          },
        ],
        volumes: [
          { name: 'config', configMap: { name: 'payment-api-config' } },
          { name: 'tmp', emptyDir: {} },
        ],
        priorityClassName: 'high-priority',
        labels: { team: 'payments', tier: 'backend' },
        annotations: { 'prometheus.io/scrape': 'true', 'prometheus.io/port': '9090' },
      },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'payment-api',
    selector: { app: 'payment-api' },
    ports: [
      { name: 'http', port: 80, targetPort: 8080 },
      { name: 'metrics', port: 9090 },
    ],
  });
  buildDeployment(db, {
    namespace: ns,
    name: 'cart-service',
    age: 160 * DAY,
    replicas: small ? 1 : 2,
    oldRevisions: 7,
    template: tpl(
      'cart-service',
      [
        {
          name: 'cart-service',
          image: 'ghcr.io/acme/cart-service:1.9.0',
          ports: [8080],
          cpu: ['100m', '500m'],
          mem: ['128Mi', '256Mi'],
          probe: 'http',
          env: [['REDIS_ADDR', 'redis.data.svc.cluster.local:6379']],
        },
      ],
      { sa: 'default' },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'cart-service',
    selector: { app: 'cart-service' },
    ports: [{ name: 'http', port: 80, targetPort: 8080 }],
  });
  if (!small) {
    buildDeployment(db, {
      namespace: ns,
      name: 'checkout-web',
      age: 90 * DAY,
      replicas: 2,
      oldRevisions: 3,
      template: tpl('checkout-web', [
        {
          name: 'app',
          image: 'ghcr.io/acme/checkout-web:3.4.1',
          ports: [3000],
          cpu: ['100m', '500m'],
          mem: ['192Mi', '384Mi'],
          probe: 'http',
          probePath: '/api/health',
        },
        {
          name: 'nginx',
          image: 'docker.io/library/nginx:1.27-alpine',
          ports: [{ name: 'proxy', port: 8080 }],
          cpu: ['20m', '100m'],
          mem: ['32Mi', '64Mi'],
        },
      ]),
    });
    buildService(db, {
      namespace: ns,
      name: 'checkout-web',
      selector: { app: 'checkout-web' },
      ports: [{ name: 'http', port: 80, targetPort: 8080 }],
    });
    buildService(db, {
      namespace: ns,
      name: 'legacy-billing',
      type: 'ExternalName',
      externalName: 'billing.internal.acme.corp',
      ports: [],
    });
  }
  if (p.id === 'c-staging') {
    buildDeployment(db, {
      namespace: ns,
      name: 'order-sync',
      age: 20 * MIN,
      replicas: 1,
      variants: { 0: 'initwait' },
      template: tpl(
        'order-sync',
        [{ name: 'order-sync', image: 'ghcr.io/acme/order-sync:0.8.0-rc.2', ports: [8080] }],
        {
          init: [
            {
              name: 'wait-for-kafka',
              image: 'docker.io/library/busybox:1.37',
              command: ['sh', '-c', 'until nc -z kafka.data 9092; do sleep 2; done'],
            },
          ],
        },
      ),
    });
  }
}

export function buildWeb(db: ClusterDb) {
  const p = db.profile;
  const ns = 'web';
  const small = p.platform === 'kind';
  buildDeployment(db, {
    namespace: ns,
    name: 'storefront',
    age: 180 * DAY,
    replicas: small ? 2 : 3,
    rsHash: '6bd9f7c7d8',
    podNames: ['4hxv2', 'm7qzp', '9sd2k'],
    variants: p.troubled ? { 2: 'notready' } : {},
    oldRevisions: 23,
    labels: { team: 'web', tier: 'frontend' },
    template: tpl(
      'storefront',
      [
        {
          name: 'storefront',
          image: 'ghcr.io/acme/storefront:5.2.0',
          ports: [3000],
          cpu: ['200m', '1'],
          mem: ['256Mi', '512Mi'],
          probe: 'http',
          probePath: '/api/health',
          env: [
            ['NODE_ENV', 'production'],
            ['API_BASE_URL', 'http://web-gateway:8080'],
            ['SESSION_SECRET', { secret: ['storefront-secrets', 'SESSION_SECRET'] }],
          ],
        },
        {
          name: 'nginx',
          image: 'docker.io/library/nginx:1.27-alpine',
          ports: [{ name: 'proxy', port: 80 }],
          cpu: ['20m', '100m'],
          mem: ['32Mi', '64Mi'],
          mounts: [['nginx-conf', '/etc/nginx/conf.d', true]],
        },
      ],
      {
        volumes: [{ name: 'nginx-conf', configMap: { name: 'storefront-nginx' } }],
        labels: { team: 'web', tier: 'frontend' },
      },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'storefront',
    selector: { app: 'storefront' },
    ports: [{ name: 'http', port: 80, targetPort: 80 }],
  });
  buildDeployment(db, {
    namespace: ns,
    name: 'web-gateway',
    age: 150 * DAY,
    replicas: small ? 1 : 3,
    variants: p.troubled && !small ? { 2: 'terminating' } : {},
    oldRevisions: 9,
    template: tpl('web-gateway', [
      {
        name: 'gateway',
        image: 'docker.io/envoyproxy/envoy:v1.32.3',
        ports: [8080, { name: 'admin', port: 9901 }],
        cpu: ['100m', '500m'],
        mem: ['64Mi', '256Mi'],
        probe: 'http',
        probePath: '/ready',
      },
    ]),
  });
  buildService(db, {
    namespace: ns,
    name: 'web-gateway',
    selector: { app: 'web-gateway' },
    ports: [{ name: 'http', port: 8080 }],
  });
  if (!small) {
    buildDeployment(db, {
      namespace: ns,
      name: 'image-resizer',
      age: 70 * DAY,
      replicas: 2,
      template: tpl('image-resizer', [
        {
          name: 'image-resizer',
          image: 'ghcr.io/acme/image-resizer:1.3.2',
          ports: [8080],
          cpu: ['500m', '2'],
          mem: ['512Mi', '2Gi'],
          probe: 'http',
        },
      ]),
    });
    buildService(db, {
      namespace: ns,
      name: 'image-resizer',
      selector: { app: 'image-resizer' },
      ports: [{ name: 'http', port: 80, targetPort: 8080 }],
    });
  }
  if (p.id === 'c-dev') {
    buildDeployment(db, {
      namespace: ns,
      name: 'feature-x-preview',
      age: 35 * MIN,
      replicas: 1,
      variants: { 0: 'imagepull' },
      template: tpl('feature-x-preview', [
        { name: 'app', image: 'ghcr.io/acme/storefront:pr-1842', ports: [3000] },
      ]),
    });
  }
  buildIngress(db, {
    namespace: ns,
    name: 'storefront',
    host: `shop.${p.domain}`,
    tls: 'storefront-tls',
    paths: [
      ['/', 'storefront', 80],
      ['/api', 'web-gateway', 8080],
      ['/images', 'image-resizer', 80],
    ],
  });
}
