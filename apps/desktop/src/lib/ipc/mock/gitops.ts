import { kindKey } from '@/lib/kube/catalog';
import { isArgoApplication, isFluxObject } from '@/lib/kube/gitops/kinds';
import {
  ARGO_REFRESH_ANNOTATION,
  FLUX_FORCE_ANNOTATION,
  FLUX_RECONCILE_ANNOTATION,
  FLUX_RESET_ANNOTATION,
} from '@/lib/kube/gitops/patches';
import type { Gvk, KubeObject } from '@/types';
import { find, getDb, put, type ClusterDb } from './fixtures/db';
import { emitEvent } from './fixtures/events';
import { hexId, nowIso } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo GitOps controllers. The GitOps actions are plain merge patches
 * (`resource_patch`); this wrapper plays the Argo CD application controller
 * and the Flux controllers so the patched objects move like real ones:
 * refreshes are acknowledged, sync operations run and finish (updating sync
 * status, resources and history), terminations stop them, enabling
 * auto-sync syncs an out-of-sync app, and Flux reconcile requests pass
 * through Reconciling before settling (force / reset heal a failed upgrade).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const COMPONENT = 'argocd-application-controller';

function current(db: ClusterDb, gvk: Gvk, o: KubeObject): KubeObject | undefined {
  return find(db, kindKey(gvk), o.metadata.namespace ?? null, o.metadata.name);
}

function later(ms: number, fn: () => void) {
  window.setTimeout(fn, ms);
}

// ---------------------------------------------------------------------------
// Argo CD
// ---------------------------------------------------------------------------

function isSha(value: string) {
  return /^[0-9a-f]{40}$/.test(value);
}

function startSync(db: ClusterDb, gvk: Gvk, app: KubeObject, operation: Json) {
  const st = (app.status ??= {}) as Json;
  const startedAt = nowIso();
  const before = st.health?.status ?? 'Healthy';
  const dryRun = operation.sync?.dryRun === true;
  st.operationState = {
    operation,
    phase: 'Running',
    message: 'one or more tasks are running',
    startedAt,
  };
  if (!dryRun) st.health = { status: 'Progressing' };
  put(db, app);
  const revision =
    String(operation.sync?.revision ?? '') || st.sync?.revision || hexId(db.rand, 40);
  emitEvent(db, {
    target: app,
    type: 'Normal',
    reason: 'OperationStarted',
    message: `Initiated ${dryRun ? 'dry-run ' : ''}sync to ${revision}`,
    firstAgo: 0,
    component: COMPONENT,
  });
  later(2600, () => {
    const live = current(db, gvk, app);
    const state = live?.status?.operationState as Json | undefined;
    if (!live || state?.phase !== 'Running' || state.startedAt !== startedAt) return;
    const s = live.status as Json;
    const finishedAt = nowIso();
    const target = isSha(revision) ? revision : s.sync?.revision || hexId(db.rand, 40);
    let resources = (s.resources as Json[] | undefined) ?? [];
    if (!dryRun) {
      if (operation.sync?.prune) resources = resources.filter((r) => !r.requiresPruning);
      resources = resources.map((r) => ({
        ...r,
        status: r.requiresPruning ? 'OutOfSync' : 'Synced',
        ...(r.health?.status === 'Missing' ? { health: { status: 'Healthy' } } : {}),
      }));
    }
    s.operationState = {
      ...state,
      phase: 'Succeeded',
      message: dryRun ? 'successfully synced (dry run)' : 'successfully synced (all tasks run)',
      finishedAt,
      syncResult: {
        revision: target,
        resources: resources.map((r) => ({
          group: r.group,
          version: r.version,
          kind: r.kind,
          namespace: r.namespace ?? '',
          name: r.name,
          status: 'Synced',
          message: `${r.kind.toLowerCase()}/${r.name} ${dryRun ? 'configured (dry run)' : 'configured'}`,
          syncPhase: 'Sync',
        })),
      },
    };
    if (!dryRun) {
      const pruneLeft = resources.some((r) => r.requiresPruning);
      s.resources = resources;
      s.sync = { ...s.sync, status: pruneLeft ? 'OutOfSync' : 'Synced', revision: target };
      s.health = {
        status: before === 'Degraded' ? 'Degraded' : 'Healthy',
        ...(before === 'Degraded' && s.health?.message ? { message: s.health.message } : {}),
      };
      const history = (s.history as Json[] | undefined) ?? [];
      history.push({
        id: history.reduce((n, h) => Math.max(n, Number(h.id) || 0), 0) + 1,
        revision: target,
        deployedAt: finishedAt,
        deployStartedAt: state.startedAt,
        source: live.spec?.source,
        initiatedBy: operation.initiatedBy ?? {},
      });
      s.history = history.slice(-10);
      if (before === 'Missing') s.conditions = undefined;
    } else {
      s.health = { ...s.health, status: before };
    }
    delete live.operation;
    put(db, live);
    emitEvent(db, {
      target: live,
      type: 'Normal',
      reason: 'OperationCompleted',
      message: `Sync operation to ${target} succeeded`,
      firstAgo: 0,
      component: COMPONENT,
    });
  });
}

function simulateArgo(db: ClusterDb, gvk: Gvk, app: KubeObject, patch: Json) {
  const refresh = app.metadata.annotations?.[ARGO_REFRESH_ANNOTATION];
  if (refresh)
    later(refresh === 'hard' ? 1400 : 700, () => {
      const live = current(db, gvk, app);
      if (!live) return;
      const annotations = { ...live.metadata.annotations };
      delete annotations[ARGO_REFRESH_ANNOTATION];
      live.metadata.annotations = annotations;
      live.status = { ...live.status, reconciledAt: nowIso() };
      put(db, live);
    });

  const phase = (app.status as Json | undefined)?.operationState?.phase;
  if (patch.operation && phase !== 'Running') startSync(db, gvk, app, app.operation as Json);

  if (patch.status?.operationState?.phase === 'Terminating')
    later(900, () => {
      const live = current(db, gvk, app);
      const s = live?.status as Json | undefined;
      if (!live || s?.operationState?.phase !== 'Terminating') return;
      s.operationState = {
        ...s.operationState,
        phase: 'Failed',
        message: 'Operation terminated',
        finishedAt: nowIso(),
      };
      if (s.health?.status === 'Progressing') s.health = { status: 'Healthy' };
      delete live.operation;
      put(db, live);
      emitEvent(db, {
        target: live,
        type: 'Warning',
        reason: 'OperationCompleted',
        message: 'Operation terminated',
        firstAgo: 0,
        component: COMPONENT,
      });
    });

  // Automated sync kicks in for an out-of-sync app once auto-sync is enabled.
  if (patch.spec?.syncPolicy?.automated)
    later(1200, () => {
      const live = current(db, gvk, app);
      const s = live?.status as Json | undefined;
      const automated = live?.spec?.syncPolicy?.automated;
      if (!live || !automated || automated.enabled === false) return;
      if (s?.sync?.status !== 'OutOfSync' || s.operationState?.phase === 'Running') return;
      const operation = {
        sync: { revision: s.sync?.revision, prune: automated.prune === true },
        initiatedBy: { automated: true },
      };
      live.operation = operation;
      startSync(db, gvk, live, operation);
    });
}

// ---------------------------------------------------------------------------
// Flux
// ---------------------------------------------------------------------------

function setCondition(conditions: Json[], next: Json): Json[] {
  return [...conditions.filter((c) => c.type !== next.type), next];
}

function reconcileFlux(db: ClusterDb, gvk: Gvk, o: KubeObject, token: string, heal: boolean) {
  const st = (o.status ??= {}) as Json;
  const before: Json[] = (st.conditions as Json[] | undefined) ?? [];
  const ready = before.find((c) => c.type === 'Ready');
  st.conditions = setCondition(
    setCondition(before, {
      type: 'Reconciling',
      status: 'True',
      reason: 'Progressing',
      message: 'reconciliation in progress',
      lastTransitionTime: nowIso(),
    }),
    {
      ...(ready ?? { type: 'Ready' }),
      status: 'Unknown',
      reason: 'Progressing',
      message: 'Reconciliation in progress',
      lastTransitionTime: nowIso(),
    },
  );
  put(db, o);
  later(1600, () => {
    const live = current(db, gvk, o);
    if (!live) return;
    const s = live.status as Json;
    let conditions = before.filter((c) => c.type !== 'Reconciling');
    const failed = ready?.status === 'False';
    if (failed && heal && live.kind === 'HelmRelease') {
      const version = String(s.lastAttemptedRevision ?? '');
      const history = ((s.history as Json[] | undefined) ?? []).map((h) =>
        h.status === 'deployed' || h.status === 'failed' ? { ...h, status: 'superseded' } : h,
      );
      const top = history.reduce((n, h) => Math.max(n, Number(h.version) || 0), 0) + 1;
      history.unshift({
        ...(history[0] ?? {}),
        chartVersion: version,
        status: 'deployed',
        version: top,
        lastDeployed: nowIso(),
      });
      s.history = history.slice(0, 5);
      s.failures = 0;
      s.upgradeFailures = 0;
      const message = `Helm upgrade succeeded for release ${live.metadata.namespace}/${live.metadata.name}.v${top} with chart ${history[0]?.chartName ?? live.metadata.name}@${version}`;
      conditions = conditions
        .filter((c) => c.type !== 'Stalled')
        .map((c) =>
          c.type === 'Ready' || c.type === 'Released'
            ? {
                ...c,
                status: 'True',
                reason: 'UpgradeSucceeded',
                message,
                lastTransitionTime: nowIso(),
              }
            : c,
        );
    } else {
      conditions = conditions.map((c) =>
        c.type === 'Ready' ? { ...c, lastTransitionTime: nowIso() } : c,
      );
    }
    s.conditions = conditions;
    s.lastHandledReconcileAt = token;
    if (s.artifact) s.artifact = { ...s.artifact, lastUpdateTime: nowIso() };
    put(db, live);
    emitEvent(db, {
      target: live,
      type: conditions.find((c) => c.type === 'Ready')?.status === 'False' ? 'Warning' : 'Normal',
      reason: conditions.find((c) => c.type === 'Ready')?.reason ?? 'ReconciliationSucceeded',
      message: conditions.find((c) => c.type === 'Ready')?.message ?? 'Reconciliation finished',
      firstAgo: 0,
      component:
        live.kind === 'HelmRelease'
          ? 'helm-controller'
          : live.kind === 'Kustomization'
            ? 'kustomize-controller'
            : 'source-controller',
    });
  });
}

function simulateFlux(db: ClusterDb, gvk: Gvk, o: KubeObject, patch: Json) {
  if (o.spec?.suspend === true) return;
  const annotations = (patch.metadata?.annotations ?? {}) as Record<string, string>;
  const token = annotations[FLUX_RECONCILE_ANNOTATION];
  const resumed = patch.spec?.suspend === false;
  if (!token && !resumed) return;
  const heal = !!annotations[FLUX_FORCE_ANNOTATION] || !!annotations[FLUX_RESET_ANNOTATION];
  reconcileFlux(db, gvk, o, token ?? nowIso(), heal);
}

const patchResource = handlers.resource_patch;
if (patchResource)
  register({
    resource_patch: async (args: MockArgs) => {
      const result = (await patchResource(args)) as KubeObject;
      const db = getDb(args.clusterId);
      const live = current(db, args.gvk as Gvk, result);
      const patch = (args.patch ?? {}) as Json;
      if (live && isArgoApplication(live)) simulateArgo(db, args.gvk as Gvk, live, patch);
      else if (live && isFluxObject(live)) simulateFlux(db, args.gvk as Gvk, live, patch);
      return result;
    },
  });
