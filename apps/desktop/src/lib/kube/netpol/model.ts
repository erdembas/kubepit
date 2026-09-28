import type { LabelSelector } from '../selectors';
import type { IpRange } from './ip';
import type { PortSet } from './ports';

/**
 * NetworkPolicy simulator model (`networking.k8s.io/v1`). Everything is
 * plain data normalised from the live objects (`parse.ts`), so the engine
 * stays pure and deterministic and never touches a cluster.
 */

export type Protocol = 'TCP' | 'UDP' | 'SCTP';
export const PROTOCOLS: readonly Protocol[] = ['TCP', 'UDP', 'SCTP'];

export type Direction = 'ingress' | 'egress';

export interface NpNamespace {
  name: string;
  labels: Readonly<Record<string, string>>;
  /**
   * Built from pod namespaces because the namespace list could not be read:
   * only the automatic `kubernetes.io/metadata.name` label is known.
   */
  synthetic?: boolean;
}

export interface NpContainerPort {
  name: string;
  port: number;
  protocol: Protocol;
  container: string;
}

/** The controller a pod belongs to (Deployment, StatefulSet…) or the pod itself. */
export interface NpWorkloadRef {
  kind: string;
  name: string;
}

export interface NpPod {
  /** Pod uid, or `template|kind|namespace|name` for a workload's pod template. */
  id: string;
  uid: string | null;
  namespace: string;
  name: string;
  labels: Readonly<Record<string, string>>;
  ips: readonly string[];
  hostIP: string | null;
  node: string | null;
  hostNetwork: boolean;
  ports: readonly NpContainerPort[];
  workload: NpWorkloadRef;
  phase: string;
  /** A workload's pod template evaluated as a pod (no IP, no node). */
  template?: boolean;
}

export interface NpPortSpec {
  protocol: Protocol;
  /** Number, named port, or null for every port of the protocol. */
  port: number | string | null;
  endPort: number | null;
}

export type NpPeer =
  | {
      type: 'pods';
      /** null: every pod (only valid together with a namespaceSelector). */
      podSelector: LabelSelector | null;
      /** null: the policy's own namespace. */
      namespaceSelector: LabelSelector | null;
    }
  | { type: 'ipBlock'; cidr: string; except: readonly string[] }
  /** A peer the API server would reject (no selector and no ipBlock, bad CIDR…). */
  | { type: 'invalid' };

export interface NpRule {
  /** Position in `spec.ingress` / `spec.egress`. */
  index: number;
  /** null: `from` / `to` omitted or empty, which matches every peer. */
  peers: readonly NpPeer[] | null;
  /** null: `ports` omitted or empty, which matches every port. */
  ports: readonly NpPortSpec[] | null;
}

export interface NpPolicy {
  uid: string;
  namespace: string;
  name: string;
  podSelector: LabelSelector;
  /** The policy isolates the pods it selects for ingress / egress. */
  ingress: boolean;
  egress: boolean;
  /** `policyTypes` was omitted and derived from the rules (API defaulting). */
  typesDefaulted: boolean;
  ingressRules: readonly NpRule[];
  egressRules: readonly NpRule[];
}

export interface NpServicePort {
  name: string;
  port: number;
  targetPort: number | string;
  protocol: Protocol;
}

export interface NpService {
  uid: string;
  namespace: string;
  name: string;
  type: string;
  /** null: no selector (ExternalName, manually managed endpoints). */
  selector: Readonly<Record<string, string>> | null;
  ports: readonly NpServicePort[];
  clusterIPs: readonly string[];
  externalName: string | null;
}

/** An immutable, indexed snapshot of everything the engine reads. */
export interface NpCluster {
  namespaces: ReadonlyMap<string, NpNamespace>;
  pods: readonly NpPod[];
  policies: readonly NpPolicy[];
  services: readonly NpService[];
  podsById: ReadonlyMap<string, NpPod>;
  podsByNamespace: ReadonlyMap<string, readonly NpPod[]>;
  policiesByNamespace: ReadonlyMap<string, readonly NpPolicy[]>;
  /** Node name → node IP (from the pods' `status.hostIP`). */
  nodeIPs: ReadonlyMap<string, string>;
  /** Namespace labels are unknown (namespaces could not be listed). */
  namespacesSynthetic: boolean;
  /** Per-snapshot memo (selector matches, isolating policies). */
  memo: Map<string, unknown>;
}

/** One side of a connection. */
export type NpEndpoint =
  | { type: 'pod'; pod: NpPod }
  /** Outside the cluster: one address or a range whose addresses all behave alike. */
  | { type: 'ip'; range: IpRange };

/** How much of the asked traffic is allowed. */
export type Coverage = 'all' | 'some' | 'none';

/** A rule whose peer matched, with the ports it allows for that peer. */
export interface RuleHit {
  policy: NpPolicy;
  direction: Direction;
  rule: number;
  /** Index of the matching peer; null when the rule has no peers (everyone). */
  peer: number | null;
  ports: PortSet;
  /** The peer is an ipBlock that matched an in-cluster pod IP. */
  ipBlockOnPod?: boolean;
}

export type SideState =
  /** The endpoint on this side is outside the cluster: no policy applies. */
  | 'external'
  /** A host-network pod: policies usually do not apply (plugin-dependent). */
  | 'host-network'
  /** No policy selects the pod for this direction: everything is allowed. */
  | 'not-isolated'
  /** A pod talking to itself is always allowed. */
  | 'loopback'
  /** Ingress from the pod's own node (kubelet probes) is always allowed. */
  | 'node'
  /** Policies select the pod: only what their rules allow gets through. */
  | 'isolated';

export interface SideResult {
  direction: Direction;
  state: SideState;
  /** Policies isolating the pod for this direction (state `isolated`). */
  policies: readonly NpPolicy[];
  /** Rules whose peer matches the other endpoint. */
  hits: readonly RuleHit[];
  /** Rules of the isolating policies whose peers do not match. */
  peerMisses: ReadonlyArray<{ policy: NpPolicy; rule: number }>;
  /** Ports this side allows (everything unless isolated). */
  ports: PortSet;
  /** Named ports of matching rules that the destination does not declare. */
  unresolved: readonly string[];
}

export interface PairResult {
  source: NpEndpoint;
  destination: NpEndpoint;
  egress: SideResult;
  ingress: SideResult;
  /** Ports allowed end to end (egress ∩ ingress). */
  ports: PortSet;
}
