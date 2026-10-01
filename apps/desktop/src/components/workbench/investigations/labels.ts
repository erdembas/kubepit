import * as i18n from '@/i18n/core';
import type {
  InvestigationEvidenceKind,
  InvestigationEvidenceReason,
  InvestigationEvidenceStatus,
} from '@/types/investigations';

export function evidenceLabel(label: string) {
  return label.endsWith('#previous')
    ? i18n.t('{container} (previous instance)', { container: label.slice(0, -9) })
    : label;
}

export function evidenceKind(kind: InvestigationEvidenceKind) {
  switch (kind) {
    case 'object':
      return i18n.t('Object snapshot');
    case 'pods':
      return i18n.t('Pod sample');
    case 'events':
      return i18n.t('Events');
    case 'logs':
      return i18n.t('Logs');
    case 'changes':
      return i18n.t('Recent changes');
    case 'metrics':
      return i18n.t('Metrics');
  }
}
export function evidenceStatus(status: InvestigationEvidenceStatus) {
  switch (status) {
    case 'captured':
      return i18n.t('Captured');
    case 'empty':
      return i18n.t('No matching data');
    case 'unavailable':
      return i18n.t('Unavailable');
    case 'truncated':
      return i18n.t('Partial sample');
  }
}
export function evidenceReason(reason: InvestigationEvidenceReason | null) {
  switch (reason) {
    case 'timeout':
      return i18n.t('This source did not respond within the capture deadline.');
    case 'forbidden':
      return i18n.t('Your Kubernetes credentials cannot read this source.');
    case 'not-found':
      return i18n.t('The object or data source was not found.');
    case 'not-available':
      return i18n.t('This data source was unavailable during capture.');
    case 'no-pods':
      return i18n.t('No readable pods or regular containers were available.');
    case 'not-recording':
      return i18n.t('Change recording was off or had not started.');
    case 'capture-limit':
      return i18n.t('The capture or history limit was reached; some evidence is missing.');
    case 'request-failed':
      return i18n.t('The source request failed. Other evidence was saved.');
    case 'no-selector':
      return i18n.t('The workload has no usable pod selector.');
    default:
      return '';
  }
}
export function investigationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('unsupported-version'))
    return i18n.t('This investigation uses an unsupported bundle version.');
  if (message.includes('bundle-too-large'))
    return i18n.t('Investigation bundles must be at most 1 MiB.');
  if (message.includes('invalid-data'))
    return i18n.t('The investigation contains invalid or oversized data.');
  if (message.includes('limit-reached'))
    return i18n.t(
      'The 50-investigation limit has been reached. Delete an old investigation first.',
    );
  if (message.includes('store-too-large'))
    return i18n.t('The investigation storage limit has been reached.');
  if (message.includes('not-found')) return i18n.t('This investigation no longer exists.');
  if (message.includes('unsupported-target'))
    return i18n.t('Start an investigation from a pod or supported workload.');
  if (message.includes('disconnected'))
    return i18n.t('Connect the cluster before capturing new evidence.');
  return i18n.t(
    'The investigation could not be saved or loaded. Check local storage and cluster connectivity, then retry.',
  );
}
