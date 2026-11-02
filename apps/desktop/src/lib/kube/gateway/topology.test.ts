import { describe, expect, it } from 'vitest';
import { NODE_H, buildGatewayTopology, topologyId } from './topology';
import { cond, gateway, gatewayClass, httpRoute, index, service } from './testing';

const EG = 'gateway.envoyproxy.io/gatewayclass-controller';

function fixture() {
  const cls = gatewayClass('eg', EG);
  const gw = gateway('public', 'infra', [
    { name: 'http', protocol: 'HTTP', port: 80, allowedRoutes: { namespaces: { from: 'All' } } },
  ]);
  const shop = httpRoute(
    'shop',
    'web',
    {
      parentRefs: [{ name: 'public', namespace: 'infra', sectionName: 'http' }],
      hostnames: ['shop.example.com'],
      rules: [
        {
          backendRefs: [
            { name: 'web', port: 80 },
            { name: 'gone', port: 80, weight: 0 },
          ],
        },
      ],
    },
    [
      {
        parentRef: { name: 'public', namespace: 'infra', sectionName: 'http' },
        conditions: [cond('Accepted', 'True')],
      },
    ],
  );
  const api = httpRoute('api', 'web', {
    parentRefs: [{ name: 'missing', namespace: 'infra' }],
    rules: [{ backendRefs: [{ name: 'web', port: 80 }] }],
  });
  return index({
    classes: [cls],
    gateways: [gw],
    routes: [shop, api],
    services: [service('web', 'web', [80])],
  });
}

describe('buildGatewayTopology', () => {
  it('lays out class → gateway → route → backend columns', () => {
    const t = buildGatewayTopology(fixture(), { namespaces: [] });
    const col = (c: number) => t.nodes.filter((n) => n.column === c).map((n) => n.name);
    expect(col(0)).toEqual(['eg']);
    expect(col(1)).toEqual(['public', 'missing']);
    expect(col(2)).toEqual(['shop', 'api']);
    expect(col(3)).toEqual(['gone', 'web']);
    expect(t.nodes.find((n) => n.name === 'missing')).toMatchObject({
      missing: true,
      tone: 'error',
    });
    expect(t.nodes.find((n) => n.name === 'gone')).toMatchObject({ missing: true });
    expect(t.nodes.find((n) => n.name === 'web')?.sub).toBe(':80');
    // Rows never overlap within a column.
    const ys = t.nodes.filter((n) => n.column === 1).map((n) => n.y);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(NODE_H);
  });

  it('colours edges by status and resolution', () => {
    const t = buildGatewayTopology(fixture(), { namespaces: [] });
    const edge = (from: string, to: string) =>
      t.edges.find((e) => e.from.endsWith(`|${from}`) && e.to.endsWith(`|${to}`));
    expect(edge('public', 'shop')).toMatchObject({ tone: 'success', dashed: false, label: 'http' });
    expect(edge('missing', 'api')).toMatchObject({ tone: 'error', dashed: true });
    expect(edge('shop', 'gone')).toMatchObject({ tone: 'error', label: 'w0' });
  });

  it('scopes by namespace and focuses one object', () => {
    const idx = fixture();
    expect(buildGatewayTopology(idx, { namespaces: ['other'] }).nodes).toEqual([]);
    const shop = idx.routes.find((r) => r.metadata.name === 'shop')!;
    const focused = buildGatewayTopology(idx, { namespaces: [], focus: topologyId(shop) });
    expect(focused.nodes.map((n) => n.name).sort()).toEqual([
      'eg',
      'gone',
      'public',
      'shop',
      'web',
    ]);
    // A route in scope pulls in its gateway from another namespace.
    expect(
      buildGatewayTopology(idx, { namespaces: ['web'] }).nodes.some((n) => n.name === 'public'),
    ).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildGatewayTopology(fixture(), { namespaces: [] })).toEqual(
      buildGatewayTopology(fixture(), { namespaces: [] }),
    );
  });
});
