import type { PssLevel } from '@/types';

export type { PssLevel };

/**
 * Pod Security Standards (https://kubernetes.io/docs/concepts/security/pod-security-standards/)
 * evaluated locally, the way the PodSecurity admission plugin does. Pure: no
 * i18n, no IPC. Reasons and details use the API server's own English wording
 * so local results read like the warnings a dry run returns.
 */

export const PSS_LEVELS: readonly PssLevel[] = ['privileged', 'baseline', 'restricted'];

/** Admission modes, in the order the namespace labels are usually read. */
export type PssMode = 'enforce' | 'audit' | 'warn';
export const PSS_MODES: readonly PssMode[] = ['enforce', 'audit', 'warn'];

export type PssCheckId =
  | 'hostNamespaces'
  | 'privileged'
  | 'capabilities_baseline'
  | 'hostPathVolumes'
  | 'hostPorts'
  | 'appArmorProfile'
  | 'seLinuxOptions'
  | 'procMount'
  | 'seccompProfile_baseline'
  | 'sysctls'
  | 'windowsHostProcess'
  | 'restrictedVolumes'
  | 'allowPrivilegeEscalation'
  | 'runAsNonRoot'
  | 'runAsUser'
  | 'seccompProfile_restricted'
  | 'capabilities_restricted';

/** One failed check of one pod spec. */
export interface PssViolation {
  check: PssCheckId;
  /** The level that introduces the check. */
  level: Exclude<PssLevel, 'privileged'>;
  /** API server reason, e.g. `allowPrivilegeEscalation != false`. */
  reason: string;
  /** API server detail, e.g. `container "web" must set securityContext.allowPrivilegeEscalation=false`. */
  detail: string;
}

/** A level at a version (`latest` or `v1.<minor>`). */
export interface PssPolicy {
  level: PssLevel;
  version: string;
}

/** The policy of one mode as read from a namespace's labels. */
export interface PssModePolicy extends PssPolicy {
  /** The level label is set (otherwise the cluster default applies, assumed privileged). */
  explicit: boolean;
  /** A label could not be parsed: the admission plugin then uses restricted:latest. */
  invalid: boolean;
}

export type NamespacePss = Record<PssMode, PssModePolicy>;
