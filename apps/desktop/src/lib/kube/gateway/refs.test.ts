import { describe, expect, it } from 'vitest';
import { GATEWAY_GROUP } from './kinds';
import { gatewayListeners, routeBackendRefs, routeParentRefs, routeSummary } from './model';
import {
  defaultRouteKinds,
  grantFor,
  hostnamesIntersect,
  matchingHostnames,
  referencePermitted,
  resolveBackend,
  resolveParent,
  routesOf,
} from './refs';
import { cond, gateway, grant, httpRoute, index, kobj, namespace, service, API } from './testing';

const http = {
  name: 'http',
  protocol: 'HTTP',
  port: 80,
  allowedRoutes: { namespaces: { from: 'All' } },
};
const https = {
  name: 'https',
  protocol: 'HTTPS',
  port: 443,
  hostname: '*.shop.example.com',
  tls: { mode: 'Terminate', certificateRefs: [{ name: 'shop-tls' }] },
};

describe('hostnamesIntersect', () => {
  it('compares exact names case-insensitively', () => {
    expect(hostnamesIntersect('api.example.com', 'API.example.com')).toBe(true);
    expect(hostnamesIntersect('api.example.com', 'www.example.com')).toBe(false);
  });

  it('matches wildcards against one or more labels but never the bare suffix', () => {
    expect(hostnamesIntersect('*.example.com', 'api.example.com')).toBe(true);
    expect(hostnamesIntersect('a.b.example.com', '*.example.com')).toBe(true);
    expect(hostnamesIntersect('*.example.com', 'example.com')).toBe(false);
    expect(hostnamesIntersect('*.example.com', 'api.example.org')).toBe(false);
  });

  it('intersects two wildcards when one suffix contains the other', () => {
    expect(hostnamesIntersect('*.example.com', '*.shop.example.com')).toBe(true);
    expect(hostnamesIntersect('*.example.com', '*.example.org')).toBe(false);
  });

  it('keeps every route hostname when the listener has none', () => {
    expect(matchingHostnames(null, ['a.example.com', 'b.example.com'])).toHaveLength(2);
    expect(
      matchingHostnames('*.shop.example.com', ['api.shop.example.com', 'blog.example.com']),
    ).toEqual(['api.shop.example.com']);
  });
});

describe('defaults', () => {
  it('defaults parentRefs to a Gateway in the route namespace', () => {
    const r = httpRoute('r', 'web', { parentRefs: [{ name: 'gw' }] });
    expect(routeParentRefs(r)).toEqual([
      {
        group: GATEWAY_GROUP,
        kind: 'Gateway',
        namespace: 'web',
        name: 'gw',
        sectionName: null,
        port: null,
      },
    ]);
  });

  it('defaults backendRefs to a core Service with weight 1 and collects mirrors', () => {
    const r = httpRoute('r', 'web', {
      rules: [
        {
          backendRefs: [{ name: 'api', port: 8080 }],
          filters: [
            { type: 'RequestMirror', requestMirror: { backendRef: { name: 'shadow', port: 80 } } },
          ],
        },
      ],
    });
    const refs = routeBackendRefs(r);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      group: '',
      kind: 'Service',
      namespace: 'web',
      name: 'api',
      weight: 1,
      mirror: false,
    });
    expect(refs[1]).toMatchObject({ name: 'shadow', mirror: true, rule: 0 });
  });

  it('joins listener spec and status by name', () => {
    const gw = gateway('gw', 'web', [http, https]);
    const ls = gatewayListeners(gw);
    expect(ls.map((l) => [l.name, l.allowedFrom, l.status?.attachedRoutes])).toEqual([
      ['http', 'All', 1],
      ['https', 'Same', 1],
    ]);
    expect(ls[1]!.tls?.certificateRefs[0]).toMatchObject({
      kind: 'Secret',
      namespace: 'web',
      name: 'shop-tls',
    });
  });

  it('knows the default route kinds of the core protocols', () => {
    expect(defaultRouteKinds('HTTPS', 'Terminate')).toEqual(['HTTPRoute', 'GRPCRoute']);
    expect(defaultRouteKinds('TLS', 'Passthrough')).toEqual(['TLSRoute']);
    expect(defaultRouteKinds('example.com/custom', null)).toBeNull();
  });
});

describe('resolveParent', () => {
  const gw = gateway('gw', 'infra', [http, https]);

  it('attaches through a matching sectionName and hostname', () => {
    const r = httpRoute('r', 'infra', {
      parentRefs: [{ name: 'gw', sectionName: 'https' }],
      hostnames: ['api.shop.example.com'],
    });
    const p = resolveParent(index({ gateways: [gw] }), r, routeParentRefs(r)[0]!);
    expect(p.problem).toBeNull();
    expect(p.attachable).toBe(true);
    expect(p.listeners.map((m) => m.listener.name)).toEqual(['https']);
  });

  it('reports a sectionName no listener has', () => {
    const r = httpRoute('r', 'infra', { parentRefs: [{ name: 'gw', sectionName: 'grpc' }] });
    const p = resolveParent(index({ gateways: [gw] }), r, routeParentRefs(r)[0]!);
    expect(p.problem).toBe('no-section');
  });

  it('reports a missing Gateway only when the Gateways list is complete', () => {
    const r = httpRoute('r', 'web', { parentRefs: [{ name: 'nope' }] });
    expect(resolveParent(index({}), r, routeParentRefs(r)[0]!).problem).toBe('gateway-missing');
    const unknown = resolveParent(index({ known: { gateways: false } }), r, routeParentRefs(r)[0]!);
    expect(unknown.problem).toBeNull();
  });

  it('enforces allowedRoutes Same for routes in another namespace', () => {
    const r = httpRoute('r', 'web', {
      parentRefs: [{ name: 'gw', namespace: 'infra', sectionName: 'https' }],
      hostnames: ['api.shop.example.com'],
    });
    const p = resolveParent(index({ gateways: [gw] }), r, routeParentRefs(r)[0]!);
    expect(p.problem).toBe('no-matching-listener');
    expect(p.listeners[0]!.mismatches).toEqual(['namespace']);
  });

  it('evaluates a namespace selector against the namespace labels', () => {
    const sel = gateway('sel', 'infra', [
      {
        name: 'http',
        protocol: 'HTTP',
        port: 80,
        allowedRoutes: {
          namespaces: { from: 'Selector', selector: { matchLabels: { gateway: 'shared' } } },
        },
      },
    ]);
    const r = httpRoute('r', 'web', { parentRefs: [{ name: 'sel', namespace: 'infra' }] });
    const ref = routeParentRefs(r)[0]!;
    const yes = resolveParent(
      index({ gateways: [sel], namespaces: [namespace('web', { gateway: 'shared' })] }),
      r,
      ref,
    );
    const no = resolveParent(index({ gateways: [sel], namespaces: [namespace('web')] }), r, ref);
    const unknown = resolveParent(index({ gateways: [sel], known: { namespaces: false } }), r, ref);
    expect(yes.attachable).toBe(true);
    expect(no.listeners[0]!.mismatches).toEqual(['namespace']);
    expect(unknown.attachable).toBe(true);
    expect(unknown.listeners[0]!.namespaceUnknown).toBe(true);
  });

  it('rejects a hostname outside the listener hostname', () => {
    const r = httpRoute('r', 'infra', {
      parentRefs: [{ name: 'gw', sectionName: 'https' }],
      hostnames: ['blog.example.org'],
    });
    const p = resolveParent(index({ gateways: [gw] }), r, routeParentRefs(r)[0]!);
    expect(p.listeners[0]!.mismatches).toEqual(['hostname']);
  });

  it('rejects a route kind the listener does not accept', () => {
    const tcp = gateway('tcp', 'infra', [{ name: 'db', protocol: 'TCP', port: 5432 }]);
    const r = httpRoute('r', 'infra', { parentRefs: [{ name: 'tcp' }] });
    const p = resolveParent(index({ gateways: [tcp] }), r, routeParentRefs(r)[0]!);
    expect(p.listeners[0]!.mismatches).toEqual(['kind']);
  });

  it('finds the status a controller wrote for the parent', () => {
    const r = httpRoute('r', 'infra', { parentRefs: [{ name: 'gw' }] }, [
      {
        parentRef: { group: GATEWAY_GROUP, kind: 'Gateway', name: 'gw', namespace: 'infra' },
        conditions: [cond('Accepted', 'True')],
      },
    ]);
    const p = resolveParent(index({ gateways: [gw] }), r, routeParentRefs(r)[0]!);
    expect(p.status?.conditions[0]?.status).toBe('True');
  });

  it('only reads the status of non-Gateway parents (GAMMA)', () => {
    const r = httpRoute('mesh', 'web', {
      parentRefs: [{ group: '', kind: 'Service', name: 'api' }],
    });
    const p = resolveParent(index({}), r, routeParentRefs(r)[0]!);
    expect(p.problem).toBe('unchecked-kind');
  });
});

describe('ReferenceGrant', () => {
  const g = grant(
    'allow-web',
    'checkout',
    [{ group: GATEWAY_GROUP, kind: 'HTTPRoute', namespace: 'web' }],
    [{ group: '', kind: 'Service' }],
  );
  const from = { group: GATEWAY_GROUP, kind: 'HTTPRoute', namespace: 'web' };

  it('permits matching from/to pairs, any name when to.name is empty', () => {
    const idx = index({ grants: [g] });
    expect(
      grantFor(idx, from, { group: '', kind: 'Service', namespace: 'checkout', name: 'payment' }),
    ).toBe(g);
    expect(
      grantFor(
        idx,
        { ...from, kind: 'GRPCRoute' },
        { group: '', kind: 'Service', namespace: 'checkout', name: 'payment' },
      ),
    ).toBeNull();
    expect(
      grantFor(idx, from, { group: '', kind: 'Secret', namespace: 'checkout', name: 'x' }),
    ).toBeNull();
  });

  it('honours a named target', () => {
    const named = grant(
      'one',
      'checkout',
      [from],
      [{ group: '', kind: 'Service', name: 'payment' }],
    );
    const idx = index({ grants: [named] });
    expect(
      grantFor(idx, from, { group: '', kind: 'Service', namespace: 'checkout', name: 'payment' }),
    ).toBe(named);
    expect(
      grantFor(idx, from, { group: '', kind: 'Service', namespace: 'checkout', name: 'other' }),
    ).toBeNull();
  });

  it('is only needed across namespaces, unknown when grants cannot be read', () => {
    const to = { group: '', kind: 'Service', namespace: 'checkout', name: 'payment' };
    expect(referencePermitted(index({}), { ...from, namespace: 'checkout' }, to)).toBe(true);
    expect(referencePermitted(index({}), from, to)).toBe(false);
    expect(referencePermitted(index({ known: { grants: false } }), from, to)).toBeNull();
  });
});

describe('resolveBackend', () => {
  const svc = service('payment', 'checkout', [9090]);

  it('flags a cross-namespace backend without a grant', () => {
    const r = httpRoute('r', 'web', {
      rules: [{ backendRefs: [{ name: 'payment', namespace: 'checkout', port: 9090 }] }],
    });
    const b = resolveBackend(index({ services: [svc] }), r, routeBackendRefs(r)[0]!);
    expect(b.crossNamespace).toBe(true);
    expect(b.problems).toEqual(['not-permitted']);
  });

  it('accepts it with a grant', () => {
    const g = grant(
      'allow',
      'checkout',
      [{ group: GATEWAY_GROUP, kind: 'HTTPRoute', namespace: 'web' }],
      [{ group: '', kind: 'Service' }],
    );
    const r = httpRoute('r', 'web', {
      rules: [{ backendRefs: [{ name: 'payment', namespace: 'checkout', port: 9090 }] }],
    });
    const b = resolveBackend(index({ services: [svc], grants: [g] }), r, routeBackendRefs(r)[0]!);
    expect(b.problems).toEqual([]);
    expect(b.grant).toBe(g);
  });

  it('checks the Service exists and exposes the port', () => {
    const r = httpRoute('r', 'checkout', {
      rules: [
        {
          backendRefs: [
            { name: 'payment', port: 80 },
            { name: 'gone', port: 80 },
            { name: 'payment' },
          ],
        },
      ],
    });
    const idx = index({ services: [svc] });
    const [a, b, c] = routeBackendRefs(r).map((ref) => resolveBackend(idx, r, ref));
    expect(a!.problems).toEqual(['port-unknown']);
    expect(b!.problems).toEqual(['service-missing']);
    expect(c!.problems).toEqual(['port-missing']);
  });

  it('does not check other backend kinds', () => {
    const r = httpRoute('r', 'web', {
      rules: [{ backendRefs: [{ group: 'gateway.envoyproxy.io', kind: 'Backend', name: 'ext' }] }],
    });
    expect(resolveBackend(index({}), r, routeBackendRefs(r)[0]!).problems).toEqual([
      'unchecked-kind',
    ]);
  });
});

describe('routes and summaries', () => {
  it('lists the routes attached to a gateway with their listeners', () => {
    const gw = gateway('gw', 'infra', [http]);
    const ok = httpRoute('ok', 'web', { parentRefs: [{ name: 'gw', namespace: 'infra' }] }, [
      { parentRef: { name: 'gw', namespace: 'infra' }, conditions: [cond('Accepted', 'True')] },
    ]);
    const other = httpRoute('other', 'web', { parentRefs: [{ name: 'else', namespace: 'infra' }] });
    const attached = routesOf(index({ gateways: [gw], routes: [ok, other] }), gw);
    expect(attached.map((a) => [a.route.metadata.name, a.listeners, a.accepted])).toEqual([
      ['ok', ['http'], true],
    ]);
  });

  it('buckets route status across parents', () => {
    const two = { parentRefs: [{ name: 'a' }, { name: 'b' }] };
    const accepted = cond('Accepted', 'True');
    const rejected = cond('Accepted', 'False', 'NotAllowedByListeners');
    const unresolved = cond('ResolvedRefs', 'False', 'RefNotPermitted');
    expect(routeSummary(httpRoute('r', 'n', two)).bucket).toBe('pending');
    expect(
      routeSummary(
        httpRoute('r', 'n', two, [
          { parentRef: { name: 'a' }, conditions: [accepted] },
          { parentRef: { name: 'b' }, conditions: [accepted] },
        ]),
      ).bucket,
    ).toBe('accepted');
    expect(
      routeSummary(
        httpRoute('r', 'n', two, [
          { parentRef: { name: 'a' }, conditions: [accepted] },
          { parentRef: { name: 'b' }, conditions: [rejected] },
        ]),
      ).bucket,
    ).toBe('partial');
    expect(
      routeSummary(
        httpRoute('r', 'n', { parentRefs: [{ name: 'a' }] }, [
          { parentRef: { name: 'a' }, conditions: [accepted, unresolved] },
        ]),
      ).bucket,
    ).toBe('unresolved');
    expect(
      routeSummary(
        httpRoute('r', 'n', { parentRefs: [{ name: 'a' }] }, [
          { parentRef: { name: 'a' }, conditions: [rejected] },
        ]),
      ).bucket,
    ).toBe('rejected');
  });

  it('reads TCP routes without hostnames', () => {
    const tcpGw = gateway('tcp', 'infra', [{ name: 'db', protocol: 'TCP', port: 5432 }]);
    const route = kobj(`${GATEWAY_GROUP}/v1alpha2`, 'TCPRoute', 'pg', 'infra', {
      spec: {
        parentRefs: [{ name: 'tcp', sectionName: 'db' }],
        rules: [{ backendRefs: [{ name: 'pg', port: 5432 }] }],
      },
    });
    const p = resolveParent(index({ gateways: [tcpGw] }), route, routeParentRefs(route)[0]!);
    expect(p.attachable).toBe(true);
    expect(API).toContain(GATEWAY_GROUP);
  });
});
