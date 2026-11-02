import type { AccessCheck, ApiResourceInfo, GatewayApiChannel } from '@/types';
import { GATEWAY_GROUP } from './kinds';

/**
 * One-click install of the Gateway API CRDs: the backend downloads the
 * release's `{channel}-install.yaml` (and checks it only holds Gateway API
 * CRDs), the UI applies it with server-side apply through
 * `resource_apply_yaml` — audited and refused on read-only clusters, the
 * same as `kubectl apply --server-side -f <url>`.
 */

/** Newest release when this was written; any later `vX.Y.Z` can be typed in. */
export const GATEWAY_API_VERSION = 'v1.7.0';

export const GATEWAY_API_RELEASES_URL = 'https://github.com/kubernetes-sigs/gateway-api/releases';
export const GATEWAY_API_GUIDE_URL = 'https://gateway-api.sigs.k8s.io/guides/getting-started/';

const VERSION = /^v\d+\.\d+\.\d+(-rc\.\d+)?$/;

export function validVersion(version: string): boolean {
  const v = version.trim();
  if (!VERSION.test(v)) return false;
  const [major, minor] = v.slice(1).split('.').map(Number);
  return major! > 1 || (major === 1 && minor! >= 1);
}

export function installUrl(channel: GatewayApiChannel, version: string): string {
  return `${GATEWAY_API_RELEASES_URL}/download/${version.trim()}/${channel}-install.yaml`;
}

export function installCommand(channel: GatewayApiChannel, version: string): string {
  return `kubectl apply --server-side -f ${installUrl(channel, version)}`;
}

/**
 * Cluster-scoped objects of the release manifest: the CRDs and the
 * `safe-upgrades` ValidatingAdmissionPolicy with its binding.
 */
export const GATEWAY_CRDS_INSTALL_ACCESS: readonly AccessCheck[] = [
  { verb: 'create', group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions' },
  { verb: 'patch', group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions' },
  {
    verb: 'create',
    group: 'admissionregistration.k8s.io',
    resource: 'validatingadmissionpolicies',
  },
  { verb: 'patch', group: 'admissionregistration.k8s.io', resource: 'validatingadmissionpolicies' },
  {
    verb: 'create',
    group: 'admissionregistration.k8s.io',
    resource: 'validatingadmissionpolicybindings',
  },
  {
    verb: 'patch',
    group: 'admissionregistration.k8s.io',
    resource: 'validatingadmissionpolicybindings',
  },
];

/** `v1.7.0` → `[1, 7, 0, rc]` (`rc` = Infinity for a final release, so it sorts after its RCs). */
function versionParts(version: string): number[] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}

/** Negative when `a` is older than `b`, 0 when equal or not comparable, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** The version the install form starts with: the installed one when newer than the default. */
export function defaultInstallVersion(installed: string | null | undefined): string {
  return installed && compareVersions(installed, GATEWAY_API_VERSION) > 0
    ? installed
    : GATEWAY_API_VERSION;
}

export type InstallRisk = 'downgrade' | 'channel' | null;

/**
 * Whether applying `version` / `channel` over the installed bundle would go
 * back: an older release, or the standard channel over the experimental one
 * (it drops the experimental resources' fields from the schemas).
 */
export function installRisk(
  installed: { version: string; channel: string } | null | undefined,
  version: string,
  channel: GatewayApiChannel,
): InstallRisk {
  if (!installed) return null;
  if (compareVersions(version, installed.version) < 0) return 'downgrade';
  if (installed.channel === 'experimental' && channel === 'standard') return 'channel';
  return null;
}

/** Discovery serves Gateways (the install is complete). */
export function gatewayCrdsServed(resources: readonly ApiResourceInfo[]): boolean {
  return resources.some((r) => r.group === GATEWAY_GROUP && r.kind === 'Gateway');
}

/** The bundle version and channel the installed CRDs carry (`gateway.networking.k8s.io/bundle-version`). */
export function installedBundle(
  crd: { metadata: { annotations?: Record<string, string> } } | null | undefined,
): { version: string; channel: string } | null {
  const a = crd?.metadata.annotations ?? {};
  const version = a['gateway.networking.k8s.io/bundle-version'];
  if (!version) return null;
  return { version, channel: a['gateway.networking.k8s.io/channel'] ?? '' };
}
