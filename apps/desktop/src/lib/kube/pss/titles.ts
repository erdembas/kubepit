import * as i18n from '@/i18n/core';
import type { PssCheckId, PssLevel, PssMode } from './types';

/** Translated names of levels, modes and checks (identifiers stay verbatim elsewhere). */

export function levelLabel(level: PssLevel): string {
  switch (level) {
    case 'restricted':
      return i18n.t('Restricted');
    case 'baseline':
      return i18n.t('Baseline');
    default:
      return i18n.t('Privileged');
  }
}

export function modeLabel(mode: PssMode): string {
  switch (mode) {
    case 'enforce':
      return i18n.t('Enforce');
    case 'audit':
      return i18n.t('Audit');
    default:
      return i18n.t('Warn');
  }
}

/** What each admission mode does with a violating pod. */
export function modeHint(mode: PssMode): string {
  switch (mode) {
    case 'enforce':
      return i18n.t('Violating pods are rejected');
    case 'audit':
      return i18n.t('Violations are recorded in the audit log');
    default:
      return i18n.t('Violations are returned as warnings to the client');
  }
}

export function checkTitle(id: PssCheckId): string {
  switch (id) {
    case 'hostNamespaces':
      return i18n.t('Host namespaces');
    case 'privileged':
      return i18n.t('Privileged containers');
    case 'capabilities_baseline':
      return i18n.t('Non-default capabilities');
    case 'hostPathVolumes':
      return i18n.t('hostPath volumes');
    case 'hostPorts':
      return i18n.t('Host ports');
    case 'appArmorProfile':
      return i18n.t('AppArmor profile');
    case 'seLinuxOptions':
      return i18n.t('SELinux options');
    case 'procMount':
      return i18n.t('/proc mount type');
    case 'seccompProfile_baseline':
      return i18n.t('Unconfined seccomp profile');
    case 'sysctls':
      return i18n.t('Unsafe sysctls');
    case 'windowsHostProcess':
      return i18n.t('Windows HostProcess');
    case 'restrictedVolumes':
      return i18n.t('Volume types');
    case 'allowPrivilegeEscalation':
      return i18n.t('Privilege escalation');
    case 'runAsNonRoot':
      return i18n.t('Running as non-root');
    case 'runAsUser':
      return i18n.t('Running as root user (UID 0)');
    case 'seccompProfile_restricted':
      return i18n.t('Seccomp profile');
    default:
      return i18n.t('Capabilities (drop ALL)');
  }
}
