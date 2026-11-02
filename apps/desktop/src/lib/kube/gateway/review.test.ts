import { describe, expect, it } from 'vitest';
import { diagnosePolicy, diagnoseRoute } from './diagnosis';
import { statHighlights } from './envoyAdmin';
import {
  compareVersions,
  defaultInstallVersion,
  installRisk,
  GATEWAY_API_VERSION,
} from './install';
import { ENVOY_GROUP, GATEWAY_GROUP } from './kinds';
import { policyBucket, routeParentRefs, routeSummary } from './model';
import { grantPermits, resolveParent, routesOf } from './refs';
import { buildGatewayTopology } from './topology';
import { cond, gateway, gatewayClass, grant, httpRoute, index, kobj } from './testing';

/** Regressions found in review: unknown lists, status matching, buckets, install safety. */

const EG = 'gateway.envoyproxy.io/gatewayclass-controller';

describe('status matching and buckets', () => {
  it('does not give one parent the status of a parent on another port', () => {
    const gw = gateway('public', 'infra', [
      { name: 'a', protocol: 'HTTP', port: 80, allowedRoutes: { namespaces: { from: 'All' } } },
      { name: 'b', protocol: 'HTTP', port: 8080, allowedRoutes: { namespaces: { from: 'All' } } },
    ]);
    const r = httpRoute(
      'r',
      'web',
      {
        parentRefs: [
          { name: 'public', namespace: 'infra', port: 80 },
          { name: 'public', namespace: 'infra', port: 8080 },
        ],
      },
      [
        {
          parentRef: { name: 'public', namespace: 'infra', port: 80 },
          conditions: [cond('Accepted', 'False', 'NotAllowedByListeners')],
        },
      ],
    );
    const idx = index({ classes: [gatewayClass('eg', EG)], gateways: [gw] });
    const [p80, p8080] = routeParentRefs(r).map((ref) => resolveParent(idx, r, ref));
    expect(p80!.status?.conditions[0]?.status).toBe('False');
    expect(p8080!.status).toBeNull();
  });

  it('counts status per parentRef, ignoring entries for removed parents', () => {
    const r = httpRoute('r', 'n', { parentRefs: [{ name: 'a' }, { name: 'b' }] }, [
      { parentRef: { name: 'a' }, conditions: [cond('Accepted', 'True')] },
      { parentRef: { name: 'old' }, conditions: [cond('Accepted', 'True')] },
    ]);
    expect(routeSummary(r)).toMatchObject({ accepted: 1, bucket: 'partial' });
  });

  it('keeps a policy pending until an ancestor accepts it', () => {
    const p = (conditions: unknown[]) =>
      kobj(`${ENVOY_GROUP}/v1alpha1`, 'SecurityPolicy', 'p', 'web', {
        spec: { targetRefs: [{ group: GATEWAY_GROUP, kind: 'Gateway', name: 'g' }] },
        status: { ancestors: [{ ancestorRef: { name: 'g' }, controllerName: EG, conditions }] },
      });
    expect(policyBucket(p([cond('Accepted', 'Unknown', 'Pending')]))).toBe('pending');
    expect(policyBucket(p([]))).toBe('pending');
    expect(policyBucket(p([cond('Accepted', 'True')]))).toBe('accepted');
  });
});

describe('unknown lists are not missing objects', () => {
  it('does not report policy targets missing while their lists are incomplete', () => {
    const policy = kobj(`${ENVOY_GROUP}/v1alpha1`, 'BackendTrafficPolicy', 'p', 'web', {
      spec: {
        targetRefs: [
          { group: GATEWAY_GROUP, kind: 'HTTPRoute', name: 'r' },
          { group: GATEWAY_GROUP, kind: 'GatewayClass', name: 'eg' },
        ],
      },
      status: {
        ancestors: [
          {
            ancestorRef: { name: 'g' },
            controllerName: EG,
            conditions: [cond('Accepted', 'True')],
          },
        ],
      },
    });
    const unknown = index({ known: { routes: false, classes: false } });
    expect(diagnosePolicy(unknown, policy).map((i) => i.code)).toEqual([]);
    expect(diagnosePolicy(index({}), policy).map((i) => i.code)).toEqual([
      'policy.target-missing',
      'policy.target-missing',
    ]);
  });

  it('gives a neutral hint when the GatewayClass list is unknown', () => {
    const gw = gateway('g', 'web', [{ name: 'http', protocol: 'HTTP', port: 80 }], {
      className: 'eg',
    });
    const r = httpRoute('r', 'web', { parentRefs: [{ name: 'g' }], rules: [{ backendRefs: [] }] });
    const [issue] = diagnoseRoute(index({ gateways: [gw], known: { classes: false } }), r).filter(
      (i) => i.code === 'route.no-status',
    );
    expect(issue!.hint).not.toMatch(/does not exist/);
  });

  it('does not paint an unknown class as an error in the topology', () => {
    const gw = gateway('g', 'web', [{ name: 'http', protocol: 'HTTP', port: 80 }], {
      className: 'eg',
    });
    const t = buildGatewayTopology(index({ gateways: [gw], known: { classes: false } }), {
      namespaces: [],
    });
    expect(t.nodes.find((n) => n.kind === 'GatewayClass')).toMatchObject({
      tone: 'muted',
      missing: false,
    });
  });

  it('links non-Service backends with their own group and names the kind in the hint', () => {
    const r = httpRoute('r', 'web', {
      parentRefs: [],
      rules: [
        {
          backendRefs: [{ group: ENVOY_GROUP, kind: 'Backend', name: 'ext', namespace: 'shared' }],
        },
      ],
    });
    const issue = diagnoseRoute(index({}), r).find(
      (i) => i.code === 'route.backend-not-permitted',
    )!;
    expect(issue.target).toMatchObject({ apiVersion: `${ENVOY_GROUP}/v1`, kind: 'Backend' });
    expect(issue.hint).toContain('Backend ext');
  });
});

describe('grants and attachments', () => {
  it('tells whether a specific grant permits a reference', () => {
    const g = grant(
      'g',
      'checkout',
      [{ group: GATEWAY_GROUP, kind: 'HTTPRoute', namespace: 'web' }],
      [{ group: '', kind: 'Service' }],
    );
    const from = { group: GATEWAY_GROUP, kind: 'HTTPRoute', namespace: 'web' };
    expect(
      grantPermits(g, from, { group: '', kind: 'Service', namespace: 'checkout', name: 'x' }),
    ).toBe(true);
    expect(
      grantPermits(g, from, { group: '', kind: 'Service', namespace: 'other', name: 'x' }),
    ).toBe(false);
  });

  it('indexes routes by gateway', () => {
    const gw = gateway('g', 'web', [{ name: 'http', protocol: 'HTTP', port: 80 }]);
    const routes = Array.from({ length: 50 }, (_, i) =>
      httpRoute(`r${i}`, 'web', { parentRefs: [{ name: i % 2 ? 'g' : 'other' }] }),
    );
    const idx = index({ gateways: [gw], routes });
    expect(idx.routesByGateway.get('web/g')).toHaveLength(25);
    expect(routesOf(idx, gw)).toHaveLength(25);
  });
});

describe('install safety', () => {
  it('compares release versions, release candidates first', () => {
    expect(compareVersions('v1.7.0', 'v1.6.3')).toBeGreaterThan(0);
    expect(compareVersions('v1.8.0-rc.1', 'v1.8.0')).toBeLessThan(0);
    expect(compareVersions('v1.10.0', 'v1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('nope', 'v1.0.0')).toBe(0);
  });

  it('starts from the newer of the installed and the default version', () => {
    expect(defaultInstallVersion('v9.0.0')).toBe('v9.0.0');
    expect(defaultInstallVersion('v1.2.0')).toBe(GATEWAY_API_VERSION);
    expect(defaultInstallVersion(null)).toBe(GATEWAY_API_VERSION);
  });

  it('flags downgrades and dropping the experimental channel', () => {
    const installed = { version: 'v1.8.0', channel: 'experimental' };
    expect(installRisk(installed, 'v1.7.0', 'experimental')).toBe('downgrade');
    expect(installRisk(installed, 'v1.8.0', 'standard')).toBe('channel');
    expect(installRisk(installed, 'v1.8.0', 'experimental')).toBeNull();
    expect(installRisk(null, 'v1.0.0', 'standard')).toBeNull();
  });
});

describe('Envoy stat highlights', () => {
  it('leave out the admin, stats and readiness listeners', () => {
    const h = statHighlights([
      { name: 'http.https-10443.downstream_rq_total', value: 100 },
      { name: 'http.admin.downstream_rq_total', value: 40 },
      { name: 'http.eg-stats-http.downstream_rq_total', value: 900 },
      { name: 'http.eg-ready-http.downstream_rq_total', value: 700 },
    ]);
    expect(h.downstreamRequests).toBe(100);
  });
});
