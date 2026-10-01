import * as i18n from '@/i18n/core';
import { asArray, asObject, asString } from '@/lib/kube/accessors';
import type { KubeObject } from '@/types';
import type { NetworkProbeResult, NetworkProbeStatus } from '@/types/networkDiagnostics';

export const objectKey = (object: KubeObject) =>
  `${object.metadata.namespace ?? ''}/${object.metadata.name}`;

export function runningContainers(pod: KubeObject | undefined): string[] {
  if (!pod) return [];
  return asArray(asObject(pod.status).containerStatuses)
    .map(asObject)
    .filter((status) => asObject(status.state).running != null)
    .map((status) => asString(status.name))
    .filter(Boolean);
}

export function servicePorts(service: KubeObject | undefined): number[] {
  if (!service) return [];
  return asArray(asObject(service.spec).ports)
    .map(asObject)
    .filter((port) => (port.protocol ?? 'TCP') === 'TCP')
    .map((port) => Number(port.port))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

export function validProbePath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.startsWith('//') &&
    path.length <= 1024 &&
    !/[^\x21-\x7e]|[?#\\]/.test(path)
  );
}

export function probeStatusLabel(status: NetworkProbeStatus): string {
  switch (status) {
    case 'passed':
      return i18n.t('Passed');
    case 'failed':
      return i18n.t('Failed');
    case 'timed_out':
      return i18n.t('Timed out');
    case 'skipped':
      return i18n.t('Skipped');
    case 'unavailable':
      return i18n.t('Unavailable');
  }
}

export function probeReasonLabel(probe: NetworkProbeResult): string {
  switch (probe.reason) {
    case 'demo_external_name':
      return i18n.t('ExternalName targets are not simulated in the browser demo.');
    case 'completed':
      return i18n.t('Probe completed successfully.');
    case 'missing_tool':
      return i18n.t('A required tool is missing from the source container.');
    case 'unsupported_tool':
      return i18n.t('The installed tool does not support the required options.');
    case 'timeout':
      return i18n.t('The probe did not complete within its time limit.');
    case 'output_limit':
      return i18n.t('The probe exceeded its output limit.');
    case 'exec_failed':
      return i18n.t('Pod exec could not complete. Check access and container state.');
    default:
      return i18n.t('The probe failed. Inspect its output for the failing layer.');
  }
}

export function networkDiagnosticsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  switch (message) {
    case 'network-diagnostics:read-only':
      return i18n.t('This cluster is read-only. Network probes require Pod exec and are disabled.');
    case 'network-diagnostics:invalid-name':
      return i18n.t('Invalid network diagnostic resource name.');
    case 'network-diagnostics:invalid-port':
      return i18n.t('Choose a port between 1 and 65535.');
    case 'network-diagnostics:invalid-path':
      return i18n.t('Use an absolute path without a query or fragment.');
    case 'network-diagnostics:exec-permission':
      return i18n.t('Pod exec permission was denied or could not be checked.');
    case 'network-diagnostics:source-not-running':
      return i18n.t('The selected source container is not running.');
    case 'network-diagnostics:invalid-service-port':
      return i18n.t('The selected Service does not expose that TCP port.');
    case 'network-diagnostics:inspection-timeout':
      return i18n.t('Service and permission inspection timed out.');
    default:
      return message;
  }
}
