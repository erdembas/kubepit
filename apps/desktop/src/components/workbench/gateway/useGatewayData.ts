import { useLocaleMemo as useMemo } from '@/i18n';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import {
  ENVOY_POLICY_KINDS,
  buildGatewayIndex,
  envoyGvk,
  gatewayGvk,
  type EnvoyPolicyKind,
  type GatewayIndex,
  type RouteKind,
} from '@/lib/kube/gateway';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { hasListError, isListComplete } from '../data/listState';
import { restartWatch, useWatch, type WatchSnapshot } from '../data/watchCache';

/**
 * Shared watches of the Gateway API view and the Gateway API details
 * sections: every kind cluster-wide (one watch per kind, shared through the
 * watch cache), falling back to the selected namespaces where listing
 * everywhere is forbidden. A list that is not complete makes the reference
 * checks say "unknown" instead of "missing".
 */

export interface GatewayList {
  gvk: Gvk;
  snap: WatchSnapshot;
  /** The namespaces the snapshot covers (`[]` = cluster-wide). */
  namespaces: readonly string[];
}

export interface GatewayData {
  classes: readonly KubeObject[];
  gateways: readonly KubeObject[];
  routes: readonly KubeObject[];
  grants: readonly KubeObject[];
  backendTlsPolicies: readonly KubeObject[];
  envoyPolicies: readonly KubeObject[];
  envoyProxies: readonly KubeObject[];
  index: GatewayIndex;
  lists: GatewayList[];
  /** Every watched list synced or failed. */
  synced: boolean;
  errors: GatewayList[];
  restart: () => void;
}

const SERVICES = toGvk(BUILTIN.Service);
const NAMESPACES = toGvk(BUILTIN.Namespace);

/** Cluster-wide watch, falling back to `namespaces` when listing everywhere is forbidden. */
function useScopedWatch(
  clusterId: ClusterId,
  gvk: Gvk | null,
  namespaces: readonly string[],
  enabled: boolean,
): { snap: WatchSnapshot; namespaces: readonly string[] } {
  const namespaced = gvk?.namespaced ?? true;
  const all = useWatch(clusterId, gvk, [], enabled);
  const fallback = namespaced && all.forbidden && namespaces.length > 0;
  const scoped = useWatch(clusterId, gvk, namespaces, enabled && fallback);
  return fallback ? { snap: scoped, namespaces } : { snap: all, namespaces: [] };
}

export function useGatewayData(
  clusterId: ClusterId,
  apiResources: readonly ApiResourceInfo[] | null,
  namespaces: readonly string[],
  enabled: boolean,
): GatewayData {
  const gvks = useMemo(() => {
    const route = (k: RouteKind) => gatewayGvk(k, apiResources);
    const policy = (k: EnvoyPolicyKind) => envoyGvk(k, apiResources);
    return {
      classes: gatewayGvk('GatewayClass', apiResources),
      gateways: gatewayGvk('Gateway', apiResources),
      http: route('HTTPRoute'),
      grpc: route('GRPCRoute'),
      tls: route('TLSRoute'),
      tcp: route('TCPRoute'),
      udp: route('UDPRoute'),
      grants: gatewayGvk('ReferenceGrant', apiResources),
      backendTls: gatewayGvk('BackendTLSPolicy', apiResources),
      envoyProxy: envoyGvk('EnvoyProxy', apiResources),
      btp: policy('BackendTrafficPolicy'),
      ctp: policy('ClientTrafficPolicy'),
      sp: policy('SecurityPolicy'),
      eep: policy('EnvoyExtensionPolicy'),
      epp: policy('EnvoyPatchPolicy'),
    };
  }, [apiResources]);
  const on = enabled && !!gvks.gateways;
  // One hook per kind keeps the hook order stable; unserved kinds watch nothing.
  const w = {
    classes: useScopedWatch(clusterId, gvks.classes, namespaces, on),
    gateways: useScopedWatch(clusterId, gvks.gateways, namespaces, on),
    http: useScopedWatch(clusterId, gvks.http, namespaces, on),
    grpc: useScopedWatch(clusterId, gvks.grpc, namespaces, on),
    tls: useScopedWatch(clusterId, gvks.tls, namespaces, on),
    tcp: useScopedWatch(clusterId, gvks.tcp, namespaces, on),
    udp: useScopedWatch(clusterId, gvks.udp, namespaces, on),
    grants: useScopedWatch(clusterId, gvks.grants, namespaces, on),
    backendTls: useScopedWatch(clusterId, gvks.backendTls, namespaces, on),
    envoyProxy: useScopedWatch(clusterId, gvks.envoyProxy, namespaces, on),
    btp: useScopedWatch(clusterId, gvks.btp, namespaces, on),
    ctp: useScopedWatch(clusterId, gvks.ctp, namespaces, on),
    sp: useScopedWatch(clusterId, gvks.sp, namespaces, on),
    eep: useScopedWatch(clusterId, gvks.eep, namespaces, on),
    epp: useScopedWatch(clusterId, gvks.epp, namespaces, on),
    services: useScopedWatch(clusterId, SERVICES, namespaces, on),
    namespaces: useScopedWatch(clusterId, NAMESPACES, namespaces, on),
  };

  const lists: GatewayList[] = [];
  const add = (gvk: Gvk | null, x: { snap: WatchSnapshot; namespaces: readonly string[] }) => {
    if (gvk) lists.push({ gvk, snap: x.snap, namespaces: x.namespaces });
  };
  add(gvks.classes, w.classes);
  add(gvks.gateways, w.gateways);
  add(gvks.http, w.http);
  add(gvks.grpc, w.grpc);
  add(gvks.tls, w.tls);
  add(gvks.tcp, w.tcp);
  add(gvks.udp, w.udp);
  add(gvks.grants, w.grants);
  add(gvks.backendTls, w.backendTls);
  add(gvks.envoyProxy, w.envoyProxy);
  add(gvks.btp, w.btp);
  add(gvks.ctp, w.ctp);
  add(gvks.sp, w.sp);
  add(gvks.eep, w.eep);
  add(gvks.epp, w.epp);
  if (gvks.gateways) {
    add(SERVICES, w.services);
    add(NAMESPACES, w.namespaces);
  }

  const complete = (x: { snap: WatchSnapshot; namespaces: readonly string[] }) =>
    isListComplete(x.snap) && x.namespaces.length === 0;
  const routes = useMemo(
    () => [
      ...w.http.snap.items,
      ...w.grpc.snap.items,
      ...w.tls.snap.items,
      ...w.tcp.snap.items,
      ...w.udp.snap.items,
    ],
    [w.http.snap.items, w.grpc.snap.items, w.tls.snap.items, w.tcp.snap.items, w.udp.snap.items],
  );
  const envoyPolicies = useMemo(
    () => [
      ...w.btp.snap.items,
      ...w.ctp.snap.items,
      ...w.sp.snap.items,
      ...w.eep.snap.items,
      ...w.epp.snap.items,
    ],
    [w.btp.snap.items, w.ctp.snap.items, w.sp.snap.items, w.eep.snap.items, w.epp.snap.items],
  );
  const routeWatches = [
    [gvks.http, w.http],
    [gvks.grpc, w.grpc],
    [gvks.tls, w.tls],
    [gvks.tcp, w.tcp],
    [gvks.udp, w.udp],
  ] as const;
  const known = {
    classes: complete(w.classes),
    gateways: complete(w.gateways),
    // Every served route kind's list is complete (unserved kinds hold nothing).
    routes: routeWatches.every(([gvk, x]) => !gvk || complete(x)),
    services: complete(w.services),
    namespaces: complete(w.namespaces),
    // An unserved ReferenceGrant kind means no grant can exist.
    grants: !gvks.grants || complete(w.grants),
  };
  const knownKey = Object.values(known).join(',');
  const index = useMemo(
    () =>
      buildGatewayIndex({
        classes: w.classes.snap.items,
        gateways: w.gateways.snap.items,
        routes,
        grants: w.grants.snap.items,
        services: w.services.snap.items,
        namespaces: w.namespaces.snap.items,
        known,
      }),
    // `knownKey` captures `known` by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      w.classes.snap.items,
      w.gateways.snap.items,
      routes,
      w.grants.snap.items,
      w.services.snap.items,
      w.namespaces.snap.items,
      knownKey,
    ],
  );

  return {
    classes: w.classes.snap.items,
    gateways: w.gateways.snap.items,
    routes,
    grants: w.grants.snap.items,
    backendTlsPolicies: w.backendTls.snap.items,
    envoyPolicies,
    envoyProxies: w.envoyProxy.snap.items,
    index,
    lists,
    synced: lists.length > 0 && lists.every((l) => l.snap.synced || l.snap.status === 'error'),
    errors: lists.filter((l) => hasListError(l.snap) && l.snap.error),
    restart: () => lists.forEach((l) => restartWatch(clusterId, l.gvk, l.namespaces)),
  };
}

/** Policy kinds the view's Policies tab lists (in this order). */
export const POLICY_KINDS: readonly string[] = ['BackendTLSPolicy', ...ENVOY_POLICY_KINDS];
