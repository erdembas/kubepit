import * as i18n from '@/i18n/core';

/**
 * The review dialog's acknowledgement (spec §8): a recommendation below
 * high confidence is applied only after the user ticked "I reviewed:
 * {flags}". Pure helpers of `RightsizingDialog`.
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
