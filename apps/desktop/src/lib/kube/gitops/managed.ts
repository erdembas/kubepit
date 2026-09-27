import type { KubeObject } from '@/types';
import { parseApiVersion } from '../catalog';

/**
 * "Managed by GitOps" detection from an object's own labels and annotations:
 *
 *  - Argo CD annotation tracking: `argocd.argoproj.io/tracking-id` =
 *    `<app>:<group>/<kind>:<namespace>/<name>` (the app is `<ns>_<name>` for
 *    apps outside the control-plane namespace). Like Argo CD, an id that
 *    names a different object (copied metadata) does not count.
 *  - Argo CD label tracking: `app.kubernetes.io/instance` = app name. Helm
 *    charts set the same label, so it is only a candidate the caller confirms
 *    against the Applications that exist; objects with a controller owner are
 *    children, never tracked.
 *  - Flux: `kustomize.toolkit.fluxcd.io/name|namespace` (Kustomization) and
 *    `helm.toolkit.fluxcd.io/name|namespace` (HelmRelease).
 */

export const ARGO_TRACKING_ANNOTATION = 'argocd.argoproj.io/tracking-id';
export const ARGO_INSTANCE_LABEL = 'app.kubernetes.io/instance';
export const FLUX_KUSTOMIZE_LABELS = {
  name: 'kustomize.toolkit.fluxcd.io/name',
  namespace: 'kustomize.toolkit.fluxcd.io/namespace',
} as const;
export const FLUX_HELM_LABELS = {
  name: 'helm.toolkit.fluxcd.io/name',
  namespace: 'helm.toolkit.fluxcd.io/namespace',
} as const;

export type GitOpsOwnerRef =
  | {
      tool: 'argo';
      kind: 'Application';
      name: string;
      /** `null` when the id does not say (control-plane namespace). */
      namespace: string | null;
      via: 'annotation' | 'label';
    }
  | {
      tool: 'flux';
      kind: 'Kustomization' | 'HelmRelease';
      name: string;
      namespace: string;
      via: 'label';
    };

export interface ArgoTrackingId {
  app: string;
  appNamespace: string | null;
  group: string;
  kind: string;
  namespace: string;
  name: string;
}

/** `<app>:<group>/<kind>:<namespace>/<name>`; `null` when malformed. */
export function parseArgoTrackingId(value: string): ArgoTrackingId | null {
  const m = /^([^:/]+):([^/:]*)\/([^:/]+):([^/:]*)\/(.+)$/.exec(value.trim());
  if (!m) return null;
  const [, app, group, kind, namespace, name] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return { ...splitAppName(app), group, kind, namespace, name };
}

/** Argo CD's `<namespace>_<name>` app naming (names cannot contain `_`). */
export function splitAppName(value: string): { app: string; appNamespace: string | null } {
  const i = value.indexOf('_');
  return i > 0
    ? { app: value.slice(i + 1), appNamespace: value.slice(0, i) }
    : { app: value, appNamespace: null };
}

function tracks(id: ArgoTrackingId, obj: KubeObject): boolean {
  if (id.kind !== obj.kind || id.name !== obj.metadata.name) return false;
  if (id.group !== parseApiVersion(obj.apiVersion ?? '').group) return false;
  const ns = obj.metadata.namespace ?? '';
  return !id.namespace || !ns || id.namespace === ns;
}

/** Every GitOps owner candidate of `obj`, most specific first. */
export function gitopsOwnerRefs(obj: KubeObject): GitOpsOwnerRef[] {
  const labels = obj.metadata.labels ?? {};
  const annotations = obj.metadata.annotations ?? {};
  const out: GitOpsOwnerRef[] = [];

  const helmName = labels[FLUX_HELM_LABELS.name];
  const helmNs = labels[FLUX_HELM_LABELS.namespace];
  if (helmName && helmNs)
    out.push({
      tool: 'flux',
      kind: 'HelmRelease',
      name: helmName,
      namespace: helmNs,
      via: 'label',
    });
  const ksName = labels[FLUX_KUSTOMIZE_LABELS.name];
  const ksNs = labels[FLUX_KUSTOMIZE_LABELS.namespace];
  if (ksName && ksNs)
    out.push({ tool: 'flux', kind: 'Kustomization', name: ksName, namespace: ksNs, via: 'label' });

  const tracking = annotations[ARGO_TRACKING_ANNOTATION];
  const id = tracking ? parseArgoTrackingId(tracking) : null;
  if (id && tracks(id, obj)) {
    out.push({
      tool: 'argo',
      kind: 'Application',
      name: id.app,
      namespace: id.appNamespace,
      via: 'annotation',
    });
  } else if (!tracking) {
    const instance = labels[ARGO_INSTANCE_LABEL];
    const controlled = obj.metadata.ownerReferences?.some((r) => r.controller);
    if (instance && !controlled && /^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/.test(instance)) {
      const { app, appNamespace } = splitAppName(instance);
      out.push({
        tool: 'argo',
        kind: 'Application',
        name: app,
        namespace: appNamespace,
        via: 'label',
      });
    }
  }
  return out;
}

/** Stable identity of an owner candidate (cache keys). */
export function ownerRefKey(ref: GitOpsOwnerRef): string {
  return `${ref.tool}:${ref.kind}:${ref.namespace ?? '*'}/${ref.name}:${ref.via}`;
}
