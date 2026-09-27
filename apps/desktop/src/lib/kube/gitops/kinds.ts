import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { gvkFromApiResource, kindKey, parseApiVersion } from '../catalog';

/**
 * GitOps controllers Kubepit understands: Argo CD (Applications,
 * ApplicationSets, AppProjects) and the Flux toolkit (every kind of its API
 * groups). Detection is discovery-driven: the navigator section and the
 * overview only appear when the cluster serves one of these kinds.
 */

export type GitOpsTool = 'argo' | 'flux';

export const ARGO_GROUP = 'argoproj.io';

export const FLUX_GROUPS = {
  kustomize: 'kustomize.toolkit.fluxcd.io',
  helm: 'helm.toolkit.fluxcd.io',
  source: 'source.toolkit.fluxcd.io',
  notification: 'notification.toolkit.fluxcd.io',
  image: 'image.toolkit.fluxcd.io',
} as const;

const FLUX_GROUP_SET = new Set<string>(Object.values(FLUX_GROUPS));

export interface GitOpsKind extends Gvk {
  key: string;
  tool: GitOpsTool;
}

function kind(tool: GitOpsTool, group: string, version: string, name: string, plural: string) {
  return {
    tool,
    group,
    version,
    kind: name,
    plural,
    namespaced: true,
    key: `${plural}.${group}`,
  } satisfies GitOpsKind;
}

/** Every known GitOps kind in navigator order; versions are used only before discovery answers. */
export const GITOPS_KINDS: readonly GitOpsKind[] = [
  kind('argo', ARGO_GROUP, 'v1alpha1', 'Application', 'applications'),
  kind('argo', ARGO_GROUP, 'v1alpha1', 'ApplicationSet', 'applicationsets'),
  kind('argo', ARGO_GROUP, 'v1alpha1', 'AppProject', 'appprojects'),
  kind('flux', FLUX_GROUPS.kustomize, 'v1', 'Kustomization', 'kustomizations'),
  kind('flux', FLUX_GROUPS.helm, 'v2', 'HelmRelease', 'helmreleases'),
  kind('flux', FLUX_GROUPS.source, 'v1', 'GitRepository', 'gitrepositories'),
  kind('flux', FLUX_GROUPS.source, 'v1', 'OCIRepository', 'ocirepositories'),
  kind('flux', FLUX_GROUPS.source, 'v1', 'HelmRepository', 'helmrepositories'),
  kind('flux', FLUX_GROUPS.source, 'v1', 'HelmChart', 'helmcharts'),
  kind('flux', FLUX_GROUPS.source, 'v1', 'Bucket', 'buckets'),
  kind('flux', FLUX_GROUPS.notification, 'v1beta3', 'Alert', 'alerts'),
  kind('flux', FLUX_GROUPS.notification, 'v1beta3', 'Provider', 'providers'),
  kind('flux', FLUX_GROUPS.notification, 'v1', 'Receiver', 'receivers'),
  kind('flux', FLUX_GROUPS.image, 'v1beta2', 'ImageRepository', 'imagerepositories'),
  kind('flux', FLUX_GROUPS.image, 'v1beta2', 'ImagePolicy', 'imagepolicies'),
  kind('flux', FLUX_GROUPS.image, 'v1beta2', 'ImageUpdateAutomation', 'imageupdateautomations'),
];

const BY_KIND = new Map(GITOPS_KINDS.map((k) => [k.kind, k]));

/** Kind keys of the kinds the overview and the actions work with. */
export const GITOPS_KEYS = {
  application: `applications.${ARGO_GROUP}`,
  applicationSet: `applicationsets.${ARGO_GROUP}`,
  appProject: `appprojects.${ARGO_GROUP}`,
  kustomization: `kustomizations.${FLUX_GROUPS.kustomize}`,
  helmRelease: `helmreleases.${FLUX_GROUPS.helm}`,
} as const;

const ARGO_PLURALS = new Set(['applications', 'applicationsets', 'appprojects']);

/** Kinds shown in the navigator's GitOps section (and left out of Custom Resources). */
export function isGitOpsResource(r: Pick<Gvk, 'group' | 'plural'>): boolean {
  if (r.group === ARGO_GROUP) return ARGO_PLURALS.has(r.plural);
  return FLUX_GROUP_SET.has(r.group);
}

/** Product names are never translated. */
export function toolName(tool: GitOpsTool): string {
  return tool === 'argo' ? 'Argo CD' : 'Flux';
}

function order(r: Pick<Gvk, 'group' | 'plural'>): number {
  const i = GITOPS_KINDS.findIndex((k) => k.group === r.group && k.plural === r.plural);
  return i < 0 ? GITOPS_KINDS.length : i;
}

/** Served GitOps kinds, one entry per kind key, in navigator order. */
export function gitopsResources(
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): ApiResourceInfo[] {
  const seen = new Set<string>();
  const out: ApiResourceInfo[] = [];
  for (const r of apiResources ?? []) {
    if (!isGitOpsResource(r)) continue;
    const key = kindKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => order(a) - order(b) || a.kind.localeCompare(b.kind));
}

export interface GitOpsDetection {
  argo: boolean;
  flux: boolean;
  /** At least one Application, Kustomization or HelmRelease kind is served. */
  overview: boolean;
}

export function detectGitOps(
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): GitOpsDetection {
  const served = new Set(gitopsResources(apiResources).map((r) => kindKey(r)));
  const argo = [...served].some((k) => k.endsWith(`.${ARGO_GROUP}`));
  const flux = [...served].some((k) => FLUX_GROUP_SET.has(k.slice(k.indexOf('.') + 1)));
  return {
    argo,
    flux,
    overview:
      served.has(GITOPS_KEYS.application) ||
      served.has(GITOPS_KEYS.kustomization) ||
      served.has(GITOPS_KEYS.helmRelease),
  };
}

/** The served Gvk of a GitOps kind key, or `null` when the cluster does not serve it. */
export function servedGvk(
  key: string,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Gvk | null {
  const r = apiResources?.find((x) => kindKey(x) === key);
  return r ? gvkFromApiResource(r) : null;
}

/** Served Gvk, falling back to the default version (links before discovery answers). */
export function gitopsGvk(
  key: string,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Gvk | null {
  const served = servedGvk(key, apiResources);
  if (served) return served;
  const known = GITOPS_KINDS.find((k) => k.key === key);
  return known
    ? {
        group: known.group,
        version: known.version,
        kind: known.kind,
        plural: known.plural,
        namespaced: true,
      }
    : null;
}

export function groupOf(obj: Pick<KubeObject, 'apiVersion'>): string {
  return parseApiVersion(obj.apiVersion ?? '').group;
}

export function toolOf(obj: Pick<KubeObject, 'apiVersion'>): GitOpsTool | null {
  const group = groupOf(obj);
  if (group === ARGO_GROUP) return 'argo';
  return FLUX_GROUP_SET.has(group) ? 'flux' : null;
}

export const isArgoApplication = (o: KubeObject) =>
  o.kind === 'Application' && groupOf(o) === ARGO_GROUP;
export const isArgoApplicationSet = (o: KubeObject) =>
  o.kind === 'ApplicationSet' && groupOf(o) === ARGO_GROUP;
export const isArgoProject = (o: KubeObject) =>
  o.kind === 'AppProject' && groupOf(o) === ARGO_GROUP;
export const isFluxKustomization = (o: KubeObject) =>
  o.kind === 'Kustomization' && groupOf(o) === FLUX_GROUPS.kustomize;
export const isFluxHelmRelease = (o: KubeObject) =>
  o.kind === 'HelmRelease' && groupOf(o) === FLUX_GROUPS.helm;
export const isFluxSource = (o: KubeObject) => groupOf(o) === FLUX_GROUPS.source;
export const isFluxObject = (o: KubeObject) => FLUX_GROUP_SET.has(groupOf(o));

/** Flux kinds that run a reconcile loop (everything but notification Alerts and Providers). */
export function isFluxReconcilable(o: KubeObject): boolean {
  const group = groupOf(o);
  if (!FLUX_GROUP_SET.has(group)) return false;
  return !(group === FLUX_GROUPS.notification && (o.kind === 'Alert' || o.kind === 'Provider'));
}

/** Default version for a GitOps kind name (source references without an apiVersion). */
export function defaultApiVersion(kindName: string): string | null {
  const k = BY_KIND.get(kindName);
  return k ? `${k.group}/${k.version}` : null;
}
