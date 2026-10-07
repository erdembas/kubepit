import * as i18n from '@/i18n/core';

/**
 * Pure helpers of the namespace cleanup dialog ("empty a namespace"):
 * warning-code translation. No React.
 */

/** Backend and demo-backend error/warning codes → user-facing text. */
export function cleanupMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const code = raw.replace(/^.*namespace-cleanup:/, '');
  if (raw.includes('is read-only') || code === 'read-only')
    return i18n.t(
      'This cluster is read-only. The inventory can be inspected, but nothing can be deleted.',
    );
  switch (code) {
    case 'system-namespace':
      return i18n.t(
        'Kubepit refuses to empty the system namespaces (default, kube-system, kube-public, kube-node-lease).',
      );
    case 'not-found':
      return i18n.t('The namespace no longer exists. Refresh the view and try again.');
    case 'invalid-namespace':
      return i18n.t('The namespace name is empty or invalid.');
    case 'confirm-mismatch':
      return i18n.t(
        'The typed confirmation does not match the namespace name. Nothing was deleted.',
      );
    case 'terminating':
      return i18n.t(
        'The namespace is already Terminating; the cluster is deleting its contents itself.',
      );
    case 'inventory-partial':
      return i18n.t(
        'Some kinds could not be listed with these credentials. They are not part of this plan and will not be deleted.',
      );
    case 'partial':
      return i18n.t(
        'Some objects could not be deleted. Review the per-kind results and the Activity log.',
      );
    case 'disconnected':
      return i18n.t('Connect the cluster to inspect the namespace.');
    default:
      return raw;
  }
}
