import * as i18n from '@/i18n/core';
import type { ContainerResourceChange, WorkloadRecommendation } from '@/types';

/**
 * The review dialog's acknowledgement and Apply control (spec §8): a
 * recommendation below high confidence is applied only after the user
 * ticked "I reviewed: {flags}" for exactly what is shown. Pure helpers of
 * `RightsizingDialog`.
 */

/** "A, B and C" in the UI language. */
export function listText(items: readonly string[]): string {
  return new Intl.ListFormat(i18n.getFormatLocale(), { style: 'long', type: 'conjunction' }).format(
    items,
  );
}

/** The acknowledgement checkbox: "I reviewed: {flags}" (the flag labels). */
export function acknowledgementText(labels: readonly string[]): string {
  return labels.length
    ? i18n.t('I reviewed: {flags}', { flags: listText(labels) })
    : i18n.t('I reviewed the changes');
}

/**
 * What a tick acknowledges: the confidence, every flag (container, code
 * and detail, as data so a language switch keeps it) and the changes that
 * would be written. Any difference asks for the tick again.
 */
export function acknowledgementKey(
  rec: WorkloadRecommendation,
  changes: readonly ContainerResourceChange[],
): string {
  return JSON.stringify([
    rec.kind,
    rec.namespace,
    rec.name,
    rec.confidence,
    rec.containers.map((c) => [c.name, c.warnings.map((w) => [w.code, w.detail ?? null])]),
    changes.map((c) => [c.container, c.cpu_request, c.cpu_limit, c.memory_request, c.memory_limit]),
  ]);
}

/** The tick: the key of what was on screen when it was set. */
export interface AckState {
  key: string | null;
  checked: boolean;
}

export const NO_ACK: AckState = { key: null, checked: false };

/** Ticked for exactly what is shown now. */
export function isAcknowledged(ack: AckState, key: string): boolean {
  return ack.checked && ack.key === key;
}

/**
 * Why "Apply" is disabled (null = enabled), the first thing to fix first:
 * the gate (read-only cluster, RBAC), nothing to change, a failed dry run,
 * then a missing acknowledgement.
 */
export function applyBlockedReason({
  gate,
  hasChanges,
  reviewFailed,
  unacknowledged,
}: {
  gate: string | null;
  hasChanges: boolean;
  reviewFailed: boolean;
  unacknowledged: boolean;
}): string | null {
  if (gate) return gate;
  if (!hasChanges) return i18n.t('Nothing to change');
  if (reviewFailed) return i18n.t('Fix the dry-run error first');
  if (unacknowledged) return i18n.t('Tick “I reviewed” to apply');
  return null;
}

/**
 * The dialog's Apply button: enabled only with a passed dry run, nothing
 * blocking, not busy, and (when `requireAck`) the tick set for `ackKey`.
 * `blocked` is the footer's reason.
 */
export function applyControl({
  gate,
  hasChanges,
  review,
  busy,
  requireAck,
  ack,
  ackKey,
}: {
  gate: string | null;
  hasChanges: boolean;
  review: 'loading' | 'ready' | 'error';
  busy: boolean;
  requireAck: boolean;
  ack: AckState;
  ackKey: string;
}): { blocked: string | null; enabled: boolean } {
  const blocked = applyBlockedReason({
    gate,
    hasChanges,
    reviewFailed: review === 'error',
    unacknowledged: requireAck && !isAcknowledged(ack, ackKey),
  });
  return { blocked, enabled: !blocked && !busy && review === 'ready' };
}
