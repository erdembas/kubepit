import type { KubeObject } from '@/types';
import { asObject, isObject, spec } from '../accessors';

/**
 * Merge patches behind the GitOps actions. They mirror what the Argo CD API
 * server and the flux CLI write, so every action runs through the generic
 * `resource_patch` command (read-only clusters and RBAC apply as usual).
 */

export const ARGO_REFRESH_ANNOTATION = 'argocd.argoproj.io/refresh';
export const FLUX_RECONCILE_ANNOTATION = 'reconcile.fluxcd.io/requestedAt';
export const FLUX_FORCE_ANNOTATION = 'reconcile.fluxcd.io/forceAt';
export const FLUX_RESET_ANNOTATION = 'reconcile.fluxcd.io/resetAt';

/** Who Argo CD records as the initiator of syncs started from Kubepit. */
export const SYNC_INITIATOR = 'kubepit';

/** `argocd app get --refresh` / `--hard-refresh`: the controller removes the annotation. */
export function argoRefreshPatch(hard: boolean) {
  return { metadata: { annotations: { [ARGO_REFRESH_ANNOTATION]: hard ? 'hard' : 'normal' } } };
}

export interface ArgoSyncOptions {
  /** Empty: the source's target revision. */
  revision: string;
  prune: boolean;
  dryRun: boolean;
  force: boolean;
  applyOutOfSyncOnly: boolean;
  serverSideApply: boolean;
}

export const DEFAULT_SYNC_OPTIONS: ArgoSyncOptions = {
  revision: '',
  prune: false,
  dryRun: false,
  force: false,
  applyOutOfSyncOnly: false,
  serverSideApply: false,
};

/**
 * The `operation` the Argo CD API server sets for a sync request: initiator,
 * revision, prune / dry run, the hook strategy (with force) and sync options;
 * the application's retry policy is carried over like the API does.
 */
export function argoSyncPatch(app: KubeObject, opts: ArgoSyncOptions, now = new Date()) {
  const policy = asObject(spec(app).syncPolicy);
  const syncOptions = [
    ...(opts.applyOutOfSyncOnly ? ['ApplyOutOfSyncOnly=true'] : []),
    ...(opts.serverSideApply ? ['ServerSideApply=true'] : []),
  ];
  const revision = opts.revision.trim();
  return {
    operation: {
      initiatedBy: { username: SYNC_INITIATOR },
      info: [{ name: 'Reason', value: `Sync requested from Kubepit at ${now.toISOString()}` }],
      sync: {
        ...(revision ? { revision } : {}),
        prune: opts.prune,
        dryRun: opts.dryRun,
        syncStrategy: { hook: opts.force ? { force: true } : {} },
        ...(syncOptions.length ? { syncOptions } : {}),
      },
      ...(isObject(policy.retry) ? { retry: policy.retry } : {}),
    },
  };
}

/** What `argocd app terminate-op` does: the controller stops the running operation. */
export function argoTerminatePatch() {
  return { status: { operationState: { phase: 'Terminating' } } };
}

/** Enable (`automated: {}` or `enabled: true` on Argo CD 3) or remove automated sync. */
export function argoAutoSyncPatch(app: KubeObject, enable: boolean) {
  if (!enable) return { spec: { syncPolicy: { automated: null } } };
  const automated = asObject(spec(app).syncPolicy).automated;
  return {
    spec: {
      syncPolicy: {
        automated: isObject(automated) && 'enabled' in automated ? { enabled: true } : {},
      },
    },
  };
}

/** Toggle `prune` or `selfHeal` of an enabled automated sync policy. */
export function argoAutomatedPatch(field: 'prune' | 'selfHeal', value: boolean) {
  return { spec: { syncPolicy: { automated: { [field]: value } } } };
}

/** RFC 3339 token the flux CLI writes into the reconcile annotations. */
export function fluxRequestToken(now = new Date()): string {
  return now.toISOString();
}

export interface FluxReconcileOptions {
  /** HelmRelease: run an install/upgrade even without changes (`flux reconcile hr --force`). */
  force?: boolean;
  /** HelmRelease: reset the failure counters (`flux reconcile hr --reset`). */
  reset?: boolean;
}

/** `flux reconcile`: request a reconciliation (force/reset reuse the same token, as the CLI does). */
export function fluxReconcilePatch(token: string, opts: FluxReconcileOptions = {}) {
  return {
    metadata: {
      annotations: {
        [FLUX_RECONCILE_ANNOTATION]: token,
        ...(opts.force ? { [FLUX_FORCE_ANNOTATION]: token } : {}),
        ...(opts.reset ? { [FLUX_RESET_ANNOTATION]: token } : {}),
      },
    },
  };
}

/** `flux suspend` / `flux resume`. */
export function fluxSuspendPatch(suspend: boolean) {
  return { spec: { suspend } };
}
