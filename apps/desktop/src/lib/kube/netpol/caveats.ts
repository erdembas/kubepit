import type { ApiResourceInfo, KubeObject } from '@/types';
import { asArray, asObject, asString, isObject } from '../accessors';

/**
 * What the simulator cannot see: policy APIs of other engines (Cilium,
 * Calico, AdminNetworkPolicy) and whether the network plugin enforces
 * NetworkPolicy at all (best effort, from well-known DaemonSets).
 */

export interface ExtraPolicyKind {
  group: string;
  kind: string;
  /** Engine name shown to the user (a product name, never translated). */
  engine: string;
}

/** Fixed list: one watch slot each (null when the cluster does not serve it). */
export const EXTRA_POLICY_KINDS: readonly ExtraPolicyKind[] = [
  { group: 'cilium.io', kind: 'CiliumNetworkPolicy', engine: 'Cilium' },
  { group: 'cilium.io', kind: 'CiliumClusterwideNetworkPolicy', engine: 'Cilium' },
  { group: 'crd.projectcalico.org', kind: 'NetworkPolicy', engine: 'Calico' },
  { group: 'crd.projectcalico.org', kind: 'GlobalNetworkPolicy', engine: 'Calico' },
  { group: 'projectcalico.org', kind: 'NetworkPolicy', engine: 'Calico' },
  { group: 'projectcalico.org', kind: 'GlobalNetworkPolicy', engine: 'Calico' },
  { group: 'policy.networking.k8s.io', kind: 'AdminNetworkPolicy', engine: 'AdminNetworkPolicy' },
  {
    group: 'policy.networking.k8s.io',
    kind: 'BaselineAdminNetworkPolicy',
    engine: 'AdminNetworkPolicy',
  },
  {
    group: 'policy.networking.k8s.io',
    kind: 'ClusterNetworkPolicy',
    engine: 'ClusterNetworkPolicy',
  },
];

/** The served API resource of each extra kind (same order as EXTRA_POLICY_KINDS). */
export function extraPolicyResources(
  apiResources: readonly ApiResourceInfo[] | null,
): Array<ApiResourceInfo | null> {
  return EXTRA_POLICY_KINDS.map(
    (k) => apiResources?.find((r) => r.group === k.group && r.kind === k.kind) ?? null,
  );
}

export interface UnevaluatedPolicy {
  kind: ExtraPolicyKind;
  apiVersion: string;
  namespace: string | null;
  name: string;
  uid: string;
}

/** Objects of the extra kinds; Calico's mirrors of Kubernetes policies are skipped. */
export function unevaluatedPolicies(
  lists: ReadonlyArray<{ kind: ExtraPolicyKind; items: readonly KubeObject[] }>,
): UnevaluatedPolicy[] {
  const out: UnevaluatedPolicy[] = [];
  for (const { kind, items } of lists) {
    for (const obj of items) {
      if (kind.engine === 'Calico' && /^(knp|kns)\.default\./.test(obj.metadata.name)) continue;
      out.push({
        kind,
        apiVersion: obj.apiVersion,
        namespace: obj.metadata.namespace ?? null,
        name: obj.metadata.name,
        uid: obj.metadata.uid,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.kind.kind.localeCompare(b.kind.kind) ||
      (a.namespace ?? '').localeCompare(b.namespace ?? '') ||
      a.name.localeCompare(b.name),
  );
}

/** Unevaluated policies that can affect traffic of these namespaces (cluster-wide ones always). */
export function relevantUnevaluated(
  policies: readonly UnevaluatedPolicy[],
  namespaces: readonly string[],
): UnevaluatedPolicy[] {
  return policies.filter((p) => p.namespace === null || namespaces.includes(p.namespace));
}

export type Enforcement = 'enforced' | 'not-enforced' | 'unknown';

export interface CniPlugin {
  /** Product name (never translated). */
  name: string;
  /** true: enforces NetworkPolicy; false: does not; null: cannot tell. */
  enforces: boolean | null;
  /** `namespace/name` of the DaemonSet it was detected from. */
  source: string;
  /** Why enforcement is doubtful (machine-readable; the UI words it). */
  note?: 'aws-policy-agent-off' | 'aws-policy-agent-unknown' | 'kindnet-old';
}

export interface CniDetection {
  enforcement: Enforcement;
  plugins: CniPlugin[];
  /** DaemonSets could not be read. */
  unreadable: boolean;
}

interface Container {
  name: string;
  image: string;
  args: string[];
}

function containers(ds: KubeObject): Container[] {
  const spec = asObject(asObject(asObject(ds.spec).template).spec);
  return [...asArray(spec.containers), ...asArray(spec.initContainers)]
    .filter(isObject)
    .map((c) => ({
      name: asString(c.name),
      image: asString(c.image),
      args: [...asArray(c.command), ...asArray(c.args)].map((a) => asString(a)),
    }));
}

function imageName(image: string): string {
  const noDigest = image.split('@')[0]!;
  const lastSlash = noDigest.lastIndexOf('/');
  const colon = noDigest.indexOf(':', lastSlash + 1);
  return (colon >= 0 ? noDigest.slice(0, colon) : noDigest).split('/').pop() ?? '';
}

function imageTag(image: string): string {
  const noDigest = image.split('@')[0]!;
  const lastSlash = noDigest.lastIndexOf('/');
  const colon = noDigest.indexOf(':', lastSlash + 1);
  return colon >= 0 ? noDigest.slice(colon + 1) : '';
}

/** kindnetd gained NetworkPolicy support in 2024 (kind v0.24, kindnetd v20240813). */
function kindnetEnforces(tag: string): boolean | null {
  const dated = /^v(\d{8})/.exec(tag);
  if (dated) return Number(dated[1]) >= 20240813;
  if (/^v?1\.\d+/.test(tag)) return true;
  return null;
}

function detectOne(ds: KubeObject): CniPlugin | null {
  const name = ds.metadata.name;
  const source = `${ds.metadata.namespace ?? ''}/${name}`;
  const list = containers(ds);
  const images = list.map((c) => imageName(c.image));
  const has = (...names: string[]) => names.some((n) => name === n || images.includes(n));
  if (name === 'anetd') return { name: 'GKE Dataplane V2', enforces: true, source };
  if (has('cilium', 'cilium-agent')) return { name: 'Cilium', enforces: true, source };
  if (has('canal')) return { name: 'Canal', enforces: true, source };
  if (has('calico-node', 'node') && (name.includes('calico') || images.includes('calico-node')))
    return { name: 'Calico', enforces: true, source };
  if (has('antrea-agent')) return { name: 'Antrea', enforces: true, source };
  if (has('kube-router')) {
    const off = list.some((c) => c.args.includes('--run-firewall=false'));
    return { name: 'kube-router', enforces: !off, source };
  }
  if (has('weave-net', 'weave-npc')) return { name: 'Weave Net', enforces: true, source };
  if (has('azure-npm')) return { name: 'Azure NPM', enforces: true, source };
  if (has('ovnkube-node')) return { name: 'OVN-Kubernetes', enforces: true, source };
  if (has('kube-ovn-cni')) return { name: 'Kube-OVN', enforces: true, source };
  if (has('kube-network-policies'))
    return { name: 'kube-network-policies', enforces: true, source };
  if (name === 'aws-node') {
    const agent = list.find(
      (c) => c.name === 'aws-eks-nodeagent' || imageName(c.image) === 'aws-network-policy-agent',
    );
    if (!agent)
      return { name: 'Amazon VPC CNI', enforces: false, source, note: 'aws-policy-agent-off' };
    const flag = agent.args
      .flatMap((a) => a.split(/\s+/))
      .find((a) => a.startsWith('--enable-network-policy'));
    if (flag === '--enable-network-policy=true' || flag === '--enable-network-policy')
      return { name: 'Amazon VPC CNI', enforces: true, source };
    if (flag === '--enable-network-policy=false')
      return { name: 'Amazon VPC CNI', enforces: false, source, note: 'aws-policy-agent-off' };
    return { name: 'Amazon VPC CNI', enforces: null, source, note: 'aws-policy-agent-unknown' };
  }
  if (name === 'kindnet' || images.includes('kindnetd')) {
    const image = list.find((c) => imageName(c.image) === 'kindnetd')?.image ?? '';
    const enforces = kindnetEnforces(imageTag(image));
    return {
      name: 'kindnet',
      enforces,
      source,
      ...(enforces === false ? { note: 'kindnet-old' as const } : {}),
    };
  }
  if (name.includes('flannel') || images.includes('flannel'))
    return { name: 'Flannel', enforces: false, source };
  return null;
}

/** Best-effort detection from the cluster's DaemonSets (null: they could not be read). */
export function detectCni(daemonSets: readonly KubeObject[] | null): CniDetection {
  if (!daemonSets) return { enforcement: 'unknown', plugins: [], unreadable: true };
  const plugins = daemonSets
    .map(detectOne)
    .filter((p): p is CniPlugin => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  const enforcement: Enforcement = plugins.some((p) => p.enforces === true)
    ? 'enforced'
    : plugins.some((p) => p.enforces === false) && !plugins.some((p) => p.enforces === null)
      ? 'not-enforced'
      : 'unknown';
  return { enforcement, plugins, unreadable: false };
}
