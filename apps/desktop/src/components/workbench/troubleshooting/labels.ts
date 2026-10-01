import * as i18n from '@/i18n/core';
import type { DiagnosisCode, EvidenceError, EvidenceKind } from './model';

export function findingTitle(code: DiagnosisCode): string {
  switch (code) {
    case 'crash-loop':
      return i18n.t('Container is restarting repeatedly');
    case 'oom-current':
      return i18n.t('Container was OOM-killed');
    case 'oom-previous':
      return i18n.t('A previous container instance was OOM-killed');
    case 'image-pull':
      return i18n.t('Container image could not be started');
    case 'config-error':
      return i18n.t('Container configuration could not be created');
    case 'missing-config':
      return i18n.t('A configuration reference is reported missing');
    case 'pending-scheduling':
      return i18n.t('Pod has not been scheduled');
    case 'pending-startup':
      return i18n.t('Pod startup is pending');
    case 'terminated-error':
      return i18n.t('Container terminated with an error');
  }
}

export function nextCheck(code: DiagnosisCode): string {
  switch (code) {
    case 'crash-loop':
      return i18n.t(
        'Read the previous logs and termination reason, then inspect startup and liveness probes. Back-off alone does not identify why the process stopped.',
      );
    case 'oom-current':
    case 'oom-previous':
      return i18n.t(
        'Compare memory limits with historical workload peaks and inspect node pressure. A current metric cannot establish memory usage at the time of termination.',
      );
    case 'image-pull':
      return i18n.t(
        'Check the image reference, registry access and image-pull Secret references in this namespace. Use the recorded message to narrow the cause.',
      );
    case 'config-error':
      return i18n.t(
        'Review the waiting message and referenced ConfigMaps, Secrets and required keys. Reference names are shown below; their contents are not read by this diagnosis.',
      );
    case 'missing-config':
      return i18n.t(
        'Check that the named resource and required key exist in the same namespace. A reference in the Pod spec alone does not prove that the resource is missing.',
      );
    case 'pending-scheduling':
      return i18n.t(
        'Use the scheduler message to check requested resources, node selectors, affinity, taints and volume binding. These are next checks, not confirmed causes.',
      );
    case 'pending-startup':
      return i18n.t(
        'Inspect init container states, volume events and sandbox creation. If no node is assigned, open Events to look for scheduling evidence.',
      );
    case 'terminated-error':
      return i18n.t(
        'Read the container logs and recorded exit reason. An exit code alone is not enough to determine the application error.',
      );
  }
}

export function evidenceLabel(kind: EvidenceKind): string {
  switch (kind) {
    case 'state':
      return i18n.t('Observed state');
    case 'restarts':
      return i18n.t('Restart count');
    case 'termination':
      return i18n.t('Recorded termination');
    case 'event':
      return i18n.t('Related event');
    case 'condition':
      return i18n.t('Pod condition');
    case 'phase':
      return i18n.t('Pod phase');
    case 'node':
      return i18n.t('Assigned node');
    case 'memory-limit':
      return i18n.t('Current memory limit');
  }
}

export function evidenceErrorLabel(error: EvidenceError): string {
  switch (error) {
    case 'forbidden':
      return i18n.t('Permission denied. This evidence is unavailable.');
    case 'missing':
      return i18n.t('The requested evidence no longer exists or was not retained.');
    case 'timeout':
      return i18n.t('The evidence request timed out. You can retry when ready.');
    case 'unavailable':
      return i18n.t('This evidence could not be read. Check the connection and permissions.');
  }
}
