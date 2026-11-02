import type { ComponentType } from 'react';
import { envoyKindOf, gatewayKindOf, isEnvoyPolicyKind, isRouteKind } from '@/lib/kube/gateway';
import type { KubeObject } from '@/types';
import {
  EnvoyProxySections,
  GatewayClassSections,
  GatewayObjectSections,
  GatewayPolicySections,
  ReferenceGrantSections,
  RouteSections,
} from './GatewaySections';
import type { SectionProps } from './types';

/**
 * Details sections for Gateway API and Envoy Gateway objects, matched by API
 * group (`Gateway`, `Backend` or `SecurityPolicy` exist in other groups too).
 */
export function gatewaySectionsFor(obj: KubeObject): ComponentType<SectionProps> | null {
  const kind = gatewayKindOf(obj);
  if (kind === 'GatewayClass') return GatewayClassSections;
  if (kind === 'Gateway') return GatewayObjectSections;
  if (kind && isRouteKind(kind)) return RouteSections;
  if (kind === 'ReferenceGrant') return ReferenceGrantSections;
  if (kind === 'BackendTLSPolicy') return GatewayPolicySections;
  const envoy = envoyKindOf(obj);
  if (envoy && isEnvoyPolicyKind(envoy)) return GatewayPolicySections;
  if (envoy === 'EnvoyProxy') return EnvoyProxySections;
  return null;
}
