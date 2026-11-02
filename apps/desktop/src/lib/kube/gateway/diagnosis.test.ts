import { describe, expect, it } from 'vitest';
import {
  countBySeverity,
  diagnoseAll,
  diagnoseGateway,
  diagnoseGatewayClass,
  diagnosePolicy,
  diagnoseRoute,
} from './diagnosis';
import { ENVOY_GROUP, GATEWAY_GROUP } from './kinds';
import { cond, gateway, gatewayClass, grant, httpRoute, index, kobj, service } from './testing';

const EG = 'gateway.envoyproxy.io/gatewayclass-controller';
const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

const gw = gateway('public', 'infra', [
  { name: 'http', protocol: 'HTTP', port: 80, allowedRoutes: { namespaces: { from: 'All' } } },
]);
const cls = gatewayClass('eg', EG);

describe('diagnoseRoute', () => {
  it('finds nothing wrong with an accepted route and a resolvable backend', () => {
    const r = httpRoute(
      'ok',
      'web',
      {
        parentRefs: [{ name: 'public', namespace: 'infra' }],
        rules: [{ backendRefs: [{ name: 'api', port: 80 }] }],
      },
      [
        {
          parentRef: { name: 'public', namespace: 'infra' },
          conditions: [cond('Accepted', 'True'), cond('ResolvedRefs', 'True')],
        },
      ],
    );
    const idx = index({
      classes: [cls],
      gateways: [gw],
      routes: [r],
      services: [service('api', 'web', [80])],
    });
    expect(diagnoseRoute(idx, r)).toEqual([]);
  });

  it('explains a missing parent and a missing backend', () => {
    const r = httpRoute('broken', 'web', {
      parentRefs: [{ name: 'nope', namespace: 'infra' }],
      rules: [{ backendRefs: [{ name: 'gone', port: 80 }] }],
    });
    expect(codes(diagnoseRoute(index({ gateways: [gw] }), r))).toEqual([
      'route.backend-missing',
      'route.parent-missing',
    ]);
  });

  it('turns a controller rejection into a finding with a hint', () => {
    const r = httpRoute(
      'rejected',
      'web',
      {
        parentRefs: [{ name: 'public', namespace: 'infra' }],
        rules: [{ backendRefs: [{ name: 'api', port: 80 }] }],
      },
      [
        {
          parentRef: { name: 'public', namespace: 'infra' },
          conditions: [
            cond('Accepted', 'False', 'UnsupportedValue', 'filter type X is not supported'),
          ],
        },
      ],
    );
    const idx = index({ classes: [cls], gateways: [gw], services: [service('api', 'web', [80])] });
    const [issue] = diagnoseRoute(idx, r);
    expect(issue).toMatchObject({
      code: 'route.not-accepted',
      severity: 'error',
      detail: 'filter type X is not supported',
    });
    expect(issue!.hint).toBeTruthy();
  });

  it('explains the cross-namespace backend RefNotPermitted case', () => {
    const r = httpRoute(
      'cross',
      'web',
      {
        parentRefs: [{ name: 'public', namespace: 'infra' }],
        rules: [{ backendRefs: [{ name: 'payment', namespace: 'checkout', port: 9090 }] }],
      },
      [
        {
          parentRef: { name: 'public', namespace: 'infra' },
          conditions: [cond('Accepted', 'True'), cond('ResolvedRefs', 'False', 'RefNotPermitted')],
        },
      ],
    );
    const idx = index({
      classes: [cls],
      gateways: [gw],
      services: [service('payment', 'checkout', [9090])],
    });
    const issues = diagnoseRoute(idx, r);
    expect(codes(issues)).toEqual(['route.backend-not-permitted', 'route.refs-unresolved']);
    expect(issues.find((i) => i.code === 'route.backend-not-permitted')!.hint).toContain(
      'checkout',
    );

    const allow = grant(
      'allow',
      'checkout',
      [{ group: GATEWAY_GROUP, kind: 'HTTPRoute', namespace: 'web' }],
      [{ group: '', kind: 'Service' }],
    );
    const fixed = index({
      classes: [cls],
      gateways: [gw],
      services: [service('payment', 'checkout', [9090])],
      grants: [allow],
    });
    expect(codes(diagnoseRoute(fixed, r))).toEqual(['route.refs-unresolved']);
  });

  it('explains a route no controller reported on from the spec checks', () => {
    const same = gateway('same', 'infra', [{ name: 'http', protocol: 'HTTP', port: 80 }]);
    const r = httpRoute('lonely', 'web', { parentRefs: [{ name: 'same', namespace: 'infra' }] });
    const issues = diagnoseRoute(index({ classes: [cls], gateways: [same] }), r);
    expect(codes(issues)).toEqual(['route.namespace-not-allowed']);
  });

  it('warns when no controller reported although the checks pass', () => {
    const r = httpRoute('quiet', 'infra', {
      parentRefs: [{ name: 'public' }],
      rules: [{ backendRefs: [{ name: 'api', port: 80 }] }],
    });
    const issues = diagnoseRoute(
      index({ classes: [cls], gateways: [gw], services: [service('api', 'infra', [80])] }),
      r,
    );
    expect(codes(issues)).toEqual(['route.no-status']);
    expect(issues[0]!.hint).toContain('Envoy Gateway');
  });

  it('warns about rules without backends unless they redirect', () => {
    const r = httpRoute(
      'rules',
      'infra',
      {
        parentRefs: [{ name: 'public' }],
        rules: [
          {},
          { filters: [{ type: 'RequestRedirect', requestRedirect: { scheme: 'https' } }] },
        ],
      },
      [{ parentRef: { name: 'public' }, conditions: [cond('Accepted', 'True')] }],
    );
    expect(codes(diagnoseRoute(index({ classes: [cls], gateways: [gw] }), r))).toEqual([
      'route.rule-no-backends',
    ]);
  });

  it('flags a route without parents', () => {
    expect(codes(diagnoseRoute(index({}), httpRoute('orphan', 'web', {})))).toContain(
      'route.no-parents',
    );
  });
});

describe('diagnoseGateway', () => {
  it('is quiet for a programmed gateway with routes', () => {
    expect(diagnoseGateway(index({ classes: [cls], gateways: [gw] }), gw)).toEqual([]);
  });

  it('reports a missing class, conflicts and missing TLS config', () => {
    const bad = gateway(
      'bad',
      'infra',
      [
        { name: 'a', protocol: 'HTTP', port: 80 },
        { name: 'b', protocol: 'HTTP', port: 80 },
        { name: 'secure', protocol: 'HTTPS', port: 443 },
      ],
      {
        className: 'missing',
        status: {
          conditions: [
            cond('Accepted', 'True'),
            cond('Programmed', 'False', 'AddressNotAssigned', 'no LB'),
          ],
          listeners: [
            {
              name: 'a',
              attachedRoutes: 0,
              conditions: [cond('Conflicted', 'True', 'HostnameConflict')],
            },
            {
              name: 'b',
              attachedRoutes: 0,
              conditions: [cond('Conflicted', 'True', 'HostnameConflict')],
            },
            {
              name: 'secure',
              attachedRoutes: 0,
              conditions: [cond('ResolvedRefs', 'False', 'InvalidCertificateRef')],
            },
          ],
        },
      },
    );
    const issues = diagnoseGateway(index({ classes: [cls], gateways: [bad] }), bad);
    expect(codes(issues)).toEqual([
      'gateway.class-missing',
      'gateway.listener-conflicted',
      'gateway.listener-conflicted',
      'gateway.listener-duplicate',
      'gateway.listener-idle',
      'gateway.listener-idle',
      'gateway.listener-idle',
      'gateway.listener-no-tls',
      'gateway.listener-refs-unresolved',
      'gateway.not-programmed',
    ]);
    expect(issues.find((i) => i.code === 'gateway.not-programmed')!.detail).toBe('no LB');
  });

  it('needs a ReferenceGrant for a certificate in another namespace', () => {
    const tls = gateway('tls', 'infra', [
      {
        name: 'https',
        protocol: 'HTTPS',
        port: 443,
        tls: { certificateRefs: [{ name: 'wild', namespace: 'certs' }] },
      },
    ]);
    const missing = diagnoseGateway(index({ classes: [cls], gateways: [tls] }), tls);
    expect(codes(missing)).toContain('gateway.certificate-not-permitted');
    const allow = grant(
      'certs',
      'certs',
      [{ group: GATEWAY_GROUP, kind: 'Gateway', namespace: 'infra' }],
      [{ group: '', kind: 'Secret', name: 'wild' }],
    );
    const ok = diagnoseGateway(index({ classes: [cls], gateways: [tls], grants: [allow] }), tls);
    expect(codes(ok)).not.toContain('gateway.certificate-not-permitted');
  });
});

describe('diagnoseGatewayClass and policies', () => {
  it('reports unclaimed, rejected and unused classes', () => {
    const unclaimed = kobj(`${GATEWAY_GROUP}/v1`, 'GatewayClass', 'nobody', null, {
      spec: { controllerName: 'example.com/none' },
    });
    expect(codes(diagnoseGatewayClass(index({}), unclaimed))).toEqual([
      'class.unclaimed',
      'class.unused',
    ]);
    const rejected = gatewayClass('bad', EG, false);
    expect(codes(diagnoseGatewayClass(index({ gateways: [gw] }), rejected))).toEqual([
      'class.not-accepted',
      'class.unused',
    ]);
    expect(diagnoseGatewayClass(index({ gateways: [gw] }), cls)).toEqual([]);
  });

  it('checks policy targets and ancestor status', () => {
    const policy = kobj(`${ENVOY_GROUP}/v1alpha1`, 'BackendTrafficPolicy', 'retries', 'infra', {
      spec: {
        targetRefs: [{ group: GATEWAY_GROUP, kind: 'HTTPRoute', name: 'gone' }],
        retry: { numRetries: 3 },
      },
      status: {
        ancestors: [
          {
            ancestorRef: {
              group: GATEWAY_GROUP,
              kind: 'Gateway',
              name: 'public',
              namespace: 'infra',
            },
            controllerName: EG,
            conditions: [
              cond('Accepted', 'True'),
              cond('Overridden', 'True', 'Overridden', 'route policy wins'),
            ],
          },
        ],
      },
    });
    expect(codes(diagnosePolicy(index({ gateways: [gw] }), policy))).toEqual([
      'policy.overridden',
      'policy.target-missing',
    ]);
  });

  it('sorts everything most severe first and counts it', () => {
    const r = httpRoute('orphan', 'web', {});
    const all = diagnoseAll(index({ classes: [cls], gateways: [gw] }), {
      classes: [cls],
      gateways: [gw],
      routes: [r],
      policies: [],
    });
    expect(all[0]!.severity).toBe('warning');
    expect(countBySeverity(all)).toEqual({ error: 0, warning: 1, info: 0 });
  });
});
