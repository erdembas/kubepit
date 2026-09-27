import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asNumber, asObject, asString, conditions, spec, status } from './accessors';
import { parseApiVersion } from './catalog';

/**
 * Live rollout state of Deployments, StatefulSets and DaemonSets, following
 * the checks `kubectl rollout status` makes for each kind: spec observed by
 * the controller, new pods updated, old pods gone, updated pods available.
 */

export const ROLLOUT_KINDS: ReadonlySet<string> = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
]);

export function hasRollout(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): boolean {
  return ROLLOUT_KINDS.has(obj.kind) && parseApiVersion(obj.apiVersion).group === 'apps';
}

/**
 * - `complete`    every desired pod runs the current template and is available
 * - `progressing` the controller is replacing pods
 * - `paused`      a paused Deployment (changes wait for resume)
 * - `degraded`    the rollout finished but some pods are not available
 * - `failed`      progress deadline exceeded / replica failure
 * - `manual`      OnDelete strategy: pods update only when deleted
 */
export type RolloutState = 'complete' | 'progressing' | 'paused' | 'degraded' | 'failed' | 'manual';

export interface RolloutStrategy {
  type: string;
  maxSurge: string | null;
  maxUnavailable: string | null;
  /** StatefulSet partition (pods with a lower ordinal keep the old revision). */
  partition: number | null;
}

export interface RolloutProgress {
  state: RolloutState;
  /** kubectl-style one-line explanation. */
  message: string;
  desired: number;
  /** Pods running the current template. */
  updated: number;
  /**
   * Updated pods that are available. Estimated: controllers report
   * availability across all revisions, so old pods are assumed available first.
   */
  upToDate: number;
  ready: number;
  available: number;
  /** Pods of older revisions still around. */
  old: number;
  /** Total pods (can exceed `desired` while surging). */
  total: number;
  generation: number;
  observedGeneration: number;
  /** The controller has not seen the latest spec yet. */
  observing: boolean;
  strategy: RolloutStrategy;
}

function strategyOf(obj: KubeObject): RolloutStrategy {
  const raw = asObject(obj.kind === 'Deployment' ? spec(obj).strategy : spec(obj).updateStrategy);
  const rolling = asObject(raw.rollingUpdate);
  const text = (v: unknown) => (v === undefined || v === null ? null : asString(v));
  const type = asString(raw.type) || 'RollingUpdate';
  return {
    type,
    maxSurge: text(rolling.maxSurge),
    maxUnavailable: text(rolling.maxUnavailable),
    partition: rolling.partition === undefined ? null : asNumber(rolling.partition),
  };
}

export function rolloutProgress(obj: KubeObject): RolloutProgress {
  const p = computeProgress(obj);
  return { ...p, upToDate: Math.min(p.updated, Math.max(0, p.available - p.old)) };
}

function computeProgress(obj: KubeObject): Omit<RolloutProgress, 'upToDate'> {
  const s = status(obj);
  const strategy = strategyOf(obj);
  const generation = asNumber(obj.metadata.generation);
  const observedGeneration = asNumber(s.observedGeneration);
  const observing = generation > 0 && observedGeneration < generation;
  const base = { generation, observedGeneration, observing, strategy };

  if (obj.kind === 'DaemonSet') {
    const desired = asNumber(s.desiredNumberScheduled);
    const total = asNumber(s.currentNumberScheduled);
    const updated = asNumber(s.updatedNumberScheduled);
    const available = asNumber(s.numberAvailable);
    const progress = {
      ...base,
      desired,
      total,
      updated,
      ready: asNumber(s.numberReady),
      available,
      old: Math.max(0, total - updated),
    };
    if (observing) return { ...progress, state: 'progressing', message: observingMessage() };
    if (strategy.type === 'OnDelete' && updated < desired)
      return { ...progress, state: 'manual', message: onDeleteMessage() };
    if (updated < desired)
      return {
        ...progress,
        state: 'progressing',
        message: i18n.t('Waiting for rollout to finish: {updated} of {desired} new pods updated', {
          updated,
          desired,
        }),
      };
    if (available < desired)
      return {
        ...progress,
        state: 'progressing',
        message: i18n.t(
          'Waiting for rollout to finish: {available} of {desired} updated pods available',
          { available, desired },
        ),
      };
    return { ...progress, state: 'complete', message: i18n.t('Successfully rolled out') };
  }

  const desired = spec(obj).replicas === undefined ? 1 : asNumber(spec(obj).replicas);
  const total = asNumber(s.replicas);
  const updated = asNumber(s.updatedReplicas);
  const ready = asNumber(s.readyReplicas);
  const available =
    s.availableReplicas === undefined && obj.kind === 'StatefulSet'
      ? ready
      : asNumber(s.availableReplicas);
  const progress = {
    ...base,
    desired,
    total,
    updated,
    ready,
    available,
    old: Math.max(0, total - updated),
  };

  if (obj.kind === 'StatefulSet') {
    if (observing) return { ...progress, state: 'progressing', message: observingMessage() };
    if (strategy.type === 'OnDelete' && updated < desired)
      return { ...progress, state: 'manual', message: onDeleteMessage() };
    const partition = strategy.partition ?? 0;
    if (partition > 0) {
      const target = Math.max(0, desired - partition);
      if (updated < target)
        return {
          ...progress,
          state: 'progressing',
          message: i18n.t(
            'Waiting for partitioned rollout to finish: {updated} of {target} new pods updated',
            { updated, target },
          ),
        };
      return {
        ...progress,
        state: 'complete',
        message: i18n.plural(
          'Partitioned rollout complete: {count} new pod updated',
          'Partitioned rollout complete: {count} new pods updated',
          updated,
        ),
      };
    }
    const current = asString(s.currentRevision);
    const target = asString(s.updateRevision);
    if (ready < desired)
      return {
        ...progress,
        // Every pod already runs the update revision: the rollout is over, pods are unhealthy.
        state: target && current === target && updated >= desired ? 'degraded' : 'progressing',
        message: i18n.plural(
          'Waiting for {count} pod to be ready',
          'Waiting for {count} pods to be ready',
          desired - ready,
        ),
      };
    if (target && current && target !== current)
      return {
        ...progress,
        state: 'progressing',
        message: i18n.t('Waiting for rolling update to complete: {updated} pods at {revision}', {
          updated,
          revision: target,
        }),
      };
    return { ...progress, state: 'complete', message: i18n.t('Successfully rolled out') };
  }

  // Deployment
  const failure = conditions(obj).find(
    (c) =>
      (c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded') ||
      (c.type === 'ReplicaFailure' && c.status === 'True'),
  );
  if (failure)
    return {
      ...progress,
      state: 'failed',
      message:
        failure.message ??
        (failure.type === 'ReplicaFailure'
          ? i18n.t('Replica failure')
          : i18n.t('Rollout exceeded its progress deadline')),
    };
  if (spec(obj).paused === true)
    return { ...progress, state: 'paused', message: i18n.t('Rollout paused') };
  if (observing) return { ...progress, state: 'progressing', message: observingMessage() };
  if (updated < desired)
    return {
      ...progress,
      state: 'progressing',
      message: i18n.t(
        'Waiting for rollout to finish: {updated} of {desired} new replicas updated',
        { updated, desired },
      ),
    };
  if (total > updated)
    return {
      ...progress,
      state: 'progressing',
      message: i18n.plural(
        'Waiting for rollout to finish: {count} old replica pending termination',
        'Waiting for rollout to finish: {count} old replicas pending termination',
        total - updated,
      ),
    };
  const progressing = conditions(obj).find((c) => c.type === 'Progressing');
  if (available < updated)
    return {
      ...progress,
      // The controller reported the new ReplicaSet as rolled out; pods failed since.
      state: progressing?.reason === 'NewReplicaSetAvailable' ? 'degraded' : 'progressing',
      message: i18n.t(
        'Waiting for rollout to finish: {available} of {updated} updated replicas available',
        { available, updated },
      ),
    };
  return { ...progress, state: 'complete', message: i18n.t('Successfully rolled out') };
}

function observingMessage() {
  return i18n.t('Waiting for the controller to observe the new spec');
}

function onDeleteMessage() {
  return i18n.t('OnDelete strategy: pods pick up the new template only when deleted');
}
