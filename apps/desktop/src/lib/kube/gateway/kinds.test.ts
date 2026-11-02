import { describe, expect, it } from 'vitest';
import type { ApiResourceInfo } from '@/types';
import {
  controllerDomain,
  implementationFor,
  implementationName,
  implementationsServing,
  servedExtensions,
} from './implementations';
import {
  ENVOY_GROUP,
  GATEWAY_GROUP,
  GATEWAY_X_GROUP,
  detectGatewayApi,
  envoyKindOf,
  gatewayGvk,
  gatewayKindOf,
  gatewayNavResources,
} from './kinds';
import {
  gatewayCrdsServed,
  installCommand,
  installUrl,
  installedBundle,
  validVersion,
} from './install';

const res = (
  group: string,
  kind: string,
  plural: string,
  version = 'v1',
  namespaced = true,
): ApiResourceInfo => ({
  group,
  version,
  kind,
  plural,
  namespaced,
  api_version: `${group}/${version}`,
  verbs: ['get', 'list', 'watch'],
  short_names: [],
  categories: [],
});

const STANDARD = [
  res(GATEWAY_GROUP, 'Gateway', 'gateways'),
  res(GATEWAY_GROUP, 'GatewayClass', 'gatewayclasses', 'v1', false),
  res(GATEWAY_GROUP, 'HTTPRoute', 'httproutes'),
  res(GATEWAY_GROUP, 'GRPCRoute', 'grpcroutes'),
  res(GATEWAY_GROUP, 'ReferenceGrant', 'referencegrants', 'v1beta1'),
  res(GATEWAY_GROUP, 'BackendTLSPolicy', 'backendtlspolicies'),
];

describe('kinds', () => {
  it('detects the served channels and Envoy Gateway', () => {
    expect(detectGatewayApi([])).toMatchObject({ served: false, any: false, envoy: false });
    const std = detectGatewayApi(STANDARD);
    expect(std).toMatchObject({
      served: true,
      routes: ['HTTPRoute', 'GRPCRoute'],
      grants: true,
      experimental: false,
    });
    const exp = detectGatewayApi([
      ...STANDARD,
      res(GATEWAY_GROUP, 'TCPRoute', 'tcproutes', 'v1alpha2'),
      res(ENVOY_GROUP, 'SecurityPolicy', 'securitypolicies', 'v1alpha1'),
    ]);
    expect(exp).toMatchObject({ experimental: true, envoy: true });
  });

  it('orders the navigator kinds and keeps unknown ones', () => {
    const nav = gatewayNavResources([
      res(ENVOY_GROUP, 'EnvoyProxy', 'envoyproxies', 'v1alpha1'),
      res(GATEWAY_X_GROUP, 'XListenerSet', 'xlistenersets', 'v1alpha1'),
      res(ENVOY_GROUP, 'Mystery', 'mysteries', 'v1alpha1'),
      ...STANDARD,
      res(GATEWAY_GROUP, 'HTTPRoute', 'httproutes', 'v1beta1'),
      res('apps', 'Deployment', 'deployments'),
    ]);
    expect(nav.map((r) => r.kind)).toEqual([
      'GatewayClass',
      'Gateway',
      'HTTPRoute',
      'GRPCRoute',
      'ReferenceGrant',
      'BackendTLSPolicy',
      'EnvoyProxy',
      'XListenerSet',
      'Mystery',
    ]);
  });

  it('uses the served version and matches objects by group', () => {
    expect(gatewayGvk('ReferenceGrant', STANDARD)).toMatchObject({
      version: 'v1beta1',
      plural: 'referencegrants',
    });
    expect(gatewayGvk('TLSRoute', STANDARD)).toBeNull();
    expect(gatewayKindOf({ apiVersion: `${GATEWAY_GROUP}/v1`, kind: 'Gateway' })).toBe('Gateway');
    expect(gatewayKindOf({ apiVersion: 'networking.istio.io/v1', kind: 'Gateway' })).toBeNull();
    expect(envoyKindOf({ apiVersion: `${ENVOY_GROUP}/v1alpha1`, kind: 'EnvoyPatchPolicy' })).toBe(
      'EnvoyPatchPolicy',
    );
  });
});

describe('implementations', () => {
  it('recognises well-known controllers', () => {
    expect(implementationFor('gateway.envoyproxy.io/gatewayclass-controller')?.id).toBe(
      'envoy-gateway',
    );
    expect(implementationFor('istio.io/gateway-controller')?.id).toBe('istio');
    expect(implementationFor('io.cilium/gateway-controller')?.id).toBe('cilium');
    expect(implementationFor('gateway.nginx.org/nginx-gateway-controller')?.id).toBe(
      'nginx-gateway-fabric',
    );
    expect(implementationFor('konghq.com/kic-gateway-controller')?.id).toBe('kong');
    expect(implementationFor('traefik.io/gateway-controller')?.id).toBe('traefik');
    expect(implementationFor('projectcontour.io/gateway-controller')?.id).toBe('contour');
    expect(implementationFor('networking.gke.io/gateway')?.id).toBe('gke');
  });

  it('falls back to the controller domain', () => {
    expect(implementationFor('example.com/my-controller')).toBeNull();
    expect(implementationName('example.com/my-controller')).toBe('example.com');
    expect(controllerDomain(' Example.COM ')).toBe('example.com');
  });

  it('lists only the served extension kinds', () => {
    const istio = implementationFor('istio.io/gateway-controller')!;
    const served = [
      res('networking.istio.io', 'DestinationRule', 'destinationrules'),
      res('networking.istio.io', 'WorkloadGroup', 'workloadgroups'),
      res('security.istio.io', 'AuthorizationPolicy', 'authorizationpolicies'),
    ];
    expect(servedExtensions(istio, served).map((r) => r.kind)).toEqual([
      'DestinationRule',
      'AuthorizationPolicy',
    ]);
    expect(implementationsServing(served).map((i) => i.id)).toEqual(['istio']);
  });
});

describe('install', () => {
  it('accepts release versions from v1.1.0', () => {
    expect(validVersion('v1.7.0')).toBe(true);
    expect(validVersion('v1.8.0-rc.1')).toBe(true);
    expect(validVersion('v1.0.0')).toBe(false);
    expect(validVersion('1.7.0')).toBe(false);
    expect(validVersion('v1.7')).toBe(false);
    expect(validVersion('v2.0.0')).toBe(true);
  });

  it('builds the release URL and the equivalent command', () => {
    expect(installUrl('experimental', 'v1.7.0')).toBe(
      'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/experimental-install.yaml',
    );
    expect(installCommand('standard', 'v1.7.0')).toMatch(/^kubectl apply --server-side -f https:/);
  });

  it('reads the bundle version of installed CRDs', () => {
    expect(
      installedBundle({
        metadata: {
          annotations: {
            'gateway.networking.k8s.io/bundle-version': 'v1.6.3',
            'gateway.networking.k8s.io/channel': 'standard',
          },
        },
      }),
    ).toEqual({ version: 'v1.6.3', channel: 'standard' });
    expect(installedBundle({ metadata: {} })).toBeNull();
    expect(gatewayCrdsServed(STANDARD)).toBe(true);
  });
});
