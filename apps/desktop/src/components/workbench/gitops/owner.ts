import * as i18n from '@/i18n/core';
import { useMemo } from 'react';
import { ipc } from '@/lib/ipc';
import { asObject, asString, spec } from '@/lib/kube/accessors';
import { gitopsGvk, GITOPS_KEYS, servedGvk, toolName } from '@/lib/kube/gitops/kinds';
import { gitopsOwnerRefs, ownerRefKey, type GitOpsOwnerRef } from '@/lib/kube/gitops/managed';
import { argoAppStatus, fluxStatus } from '@/lib/kube/gitops/model';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { usePolled } from '../data/polled';

/**
 * Resolves the Argo CD Application / Flux Kustomization or HelmRelease that
 * manages an object (from its tracking labels and annotations) and phrases
 * what a manual change will run into. Warnings never block: they are shown
 * in the details header, the editor and the scale / set image / restart /
 * delete flows.
 */

export interface ResolvedOwner {
  ref: GitOpsOwnerRef;
  /** Kind of the owner; `null` when this cluster does not serve it (managed from elsewhere). */
  gvk: Gvk | null;
  /** The owner object, when it lives in this cluster and is readable. */
  obj: KubeObject | null;
}

export type OwnerSeverity = 'revert' | 'drift' | 'paused';

export interface OwnerWarning {
  severity: OwnerSeverity;
  text: string;
}

const LIST_TTL = 15_000;
const appLists = new Map<string, { at: number; items: Promise<KubeObject[]> }>();

/** Applications of a cluster (cluster-wide list, cached briefly for label lookups). */
function argoApplications(clusterId: ClusterId, gvk: Gvk): Promise<KubeObject[]> {
  const hit = appLists.get(clusterId);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.items;
  const items = ipc
    .resourceList(clusterId, gvk, null)
    .then((r) => r.items)
    .catch(() => [] as KubeObject[]);
  appLists.set(clusterId, { at: Date.now(), items });
  return items;
}

async function resolveOne(
  clusterId: ClusterId,
  ref: GitOpsOwnerRef,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Promise<ResolvedOwner | null> {
  if (ref.tool === 'flux') {
    const key = ref.kind === 'Kustomization' ? GITOPS_KEYS.kustomization : GITOPS_KEYS.helmRelease;
    const gvk = apiResources ? servedGvk(key, apiResources) : gitopsGvk(key, null);
    const obj = gvk
      ? await ipc.resourceGet(clusterId, gvk, ref.namespace, ref.name).catch(() => null)
      : null;
    return { ref, gvk, obj };
  }
  const gvk = apiResources
    ? servedGvk(GITOPS_KEYS.application, apiResources)
    : gitopsGvk(GITOPS_KEYS.application, null);
  // Label tracking is only trusted when a matching Application exists here.
  if (!gvk) return ref.via === 'annotation' ? { ref, gvk: null, obj: null } : null;
  let obj: KubeObject | null = null;
  if (ref.namespace) {
    obj = await ipc.resourceGet(clusterId, gvk, ref.namespace, ref.name).catch(() => null);
  } else {
    const apps = (await argoApplications(clusterId, gvk)).filter(
      (a) => a.metadata.name === ref.name,
    );
    obj = apps.find((a) => a.metadata.namespace === 'argocd') ?? apps[0] ?? null;
  }
  if (!obj && ref.via === 'label') return null;
  return { ref, gvk, obj };
}

/** The first owner candidate that resolves (most specific first). */
export async function resolveGitOpsOwner(
  clusterId: ClusterId,
  obj: KubeObject,
): Promise<ResolvedOwner | null> {
  const candidates = gitopsOwnerRefs(obj);
  if (!candidates.length) return null;
  const apiResources = useWorkbenchStore.getState().apiResources[clusterId];
  for (const ref of candidates) {
    const resolved = await resolveOne(clusterId, ref, apiResources);
    if (resolved) return resolved;
  }
  return null;
}

/** Live owner of `obj` (re-resolved every 30 s while enabled). */
export function useGitOpsOwner(
  clusterId: ClusterId,
  obj: KubeObject | null,
  enabled: boolean,
): ResolvedOwner | null {
  const candidates = useMemo(() => (obj ? gitopsOwnerRefs(obj) : []), [obj]);
  const key = candidates.length
    ? `${clusterId}|gitops-owner|${candidates.map(ownerRefKey).join(',')}`
    : null;
  const state = usePolled(
    key,
    () => (obj ? resolveGitOpsOwner(clusterId, obj) : Promise.resolve(null)),
    30_000,
    enabled,
  );
  return key ? (state.data ?? null) : null;
}

/** "Argo CD · storefront", "Flux · apps". */
export function ownerLabel(owner: ResolvedOwner): string {
  return `${toolName(owner.ref.tool)} · ${owner.ref.name}`;
}

/** What happens to manual changes of an object this owner manages. */
export function ownerWarning(owner: ResolvedOwner): OwnerWarning {
  const { ref, obj } = owner;
  const name = ref.name;
  if (ref.tool === 'argo') {
    if (!owner.gvk)
      return {
        severity: 'drift',
        text: i18n.t(
          'Managed by Argo CD app {name} from another cluster — manual changes may be reverted.',
          { name },
        ),
      };
    if (!obj)
      return {
        severity: 'drift',
        text: i18n.t('Managed by Argo CD app {name} — manual changes may be reverted.', { name }),
      };
    const s = argoAppStatus(obj);
    if (s.automated && s.selfHeal)
      return {
        severity: 'revert',
        text: i18n.t(
          'Managed by Argo CD app {name} with self-heal on — manual changes will be reverted.',
          { name },
        ),
      };
    if (s.automated)
      return {
        severity: 'drift',
        text: i18n.t(
          'Managed by Argo CD app {name} with auto-sync on — manual changes show as drift and are overwritten by the next sync.',
          { name },
        ),
      };
    return {
      severity: 'drift',
      text: i18n.t(
        'Managed by Argo CD app {name} — manual changes show as drift (OutOfSync) and are overwritten by the next sync.',
        { name },
      ),
    };
  }
  const kustomization = ref.kind === 'Kustomization';
  if (!obj)
    return {
      severity: 'drift',
      text: kustomization
        ? i18n.t('Managed by Flux Kustomization {name} — manual changes may be reverted.', { name })
        : i18n.t('Managed by Flux HelmRelease {name} — manual changes may be reverted.', { name }),
    };
  const f = fluxStatus(obj);
  if (f.suspended)
    return {
      severity: 'paused',
      text: kustomization
        ? i18n.t(
            'Managed by Flux Kustomization {name}, currently suspended — manual changes last until it is resumed.',
            { name },
          )
        : i18n.t(
            'Managed by Flux HelmRelease {name}, currently suspended — manual changes last until it is resumed.',
            { name },
          ),
    };
  if (kustomization)
    return {
      severity: 'revert',
      text: f.interval
        ? i18n.t(
            'Managed by Flux Kustomization {name} — manual changes will be reverted at the next reconciliation (every {interval}).',
            { name, interval: f.interval },
          )
        : i18n.t(
            'Managed by Flux Kustomization {name} — manual changes will be reverted at the next reconciliation.',
            { name },
          ),
    };
  const drift = asString(asObject(spec(obj).driftDetection).mode) === 'enabled';
  return drift
    ? {
        severity: 'revert',
        text: i18n.t(
          'Managed by Flux HelmRelease {name} with drift detection on — manual changes will be reverted.',
          { name },
        ),
      }
    : {
        severity: 'drift',
        text: i18n.t(
          'Managed by Flux HelmRelease {name} — manual changes are overwritten by the next Helm upgrade.',
          { name },
        ),
      };
}

/**
 * Resolve the owner warning, then continue with it (`null` when the object
 * is not GitOps-managed). Unmanaged objects continue synchronously.
 */
export function withGitOpsWarning(
  clusterId: ClusterId,
  obj: KubeObject,
  next: (warning: string | null) => void,
) {
  if (!gitopsOwnerRefs(obj).length) {
    next(null);
    return;
  }
  void resolveGitOpsOwner(clusterId, obj)
    .catch(() => null)
    .then((owner) => next(owner ? ownerWarning(owner).text : null));
}
