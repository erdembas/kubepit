import * as i18n from '@/i18n/core';
import type { KeyValue } from './encoding';
import { labelsError, nameError } from './validate';

/**
 * `kubectl create namespace` plus what teams usually add right away: Pod
 * Security Standards labels and ResourceQuota / LimitRange presets.
 */

export type PssLevel = '' | 'privileged' | 'baseline' | 'restricted';
export const PSS_LEVELS: readonly Exclude<PssLevel, ''>[] = [
  'privileged',
  'baseline',
  'restricted',
];
export type PssMode = 'enforce' | 'audit' | 'warn';
export const PSS_MODES: readonly PssMode[] = ['enforce', 'audit', 'warn'];

export type SizePreset = 'none' | 'small' | 'medium' | 'large';
export const SIZE_PRESETS: readonly SizePreset[] = ['none', 'small', 'medium', 'large'];

export interface NamespaceInput {
  name: string;
  labels: KeyValue[];
  pss: Record<PssMode, PssLevel>;
  quota: SizePreset;
  limits: SizePreset;
}

export function namespaceDefaults(): NamespaceInput {
  return {
    name: '',
    labels: [],
    pss: { enforce: '', audit: '', warn: '' },
    quota: 'none',
    limits: 'none',
  };
}

/** ResourceQuota `spec.hard` per preset. */
export const QUOTA_PRESETS: Record<Exclude<SizePreset, 'none'>, Record<string, string>> = {
  small: {
    'requests.cpu': '2',
    'requests.memory': '4Gi',
    'limits.cpu': '4',
    'limits.memory': '8Gi',
    pods: '20',
    services: '10',
    persistentvolumeclaims: '5',
    'requests.storage': '50Gi',
  },
  medium: {
    'requests.cpu': '8',
    'requests.memory': '16Gi',
    'limits.cpu': '16',
    'limits.memory': '32Gi',
    pods: '60',
    services: '30',
    persistentvolumeclaims: '15',
    'requests.storage': '200Gi',
  },
  large: {
    'requests.cpu': '32',
    'requests.memory': '64Gi',
    'limits.cpu': '64',
    'limits.memory': '128Gi',
    pods: '200',
    services: '100',
    persistentvolumeclaims: '50',
    'requests.storage': '1Ti',
  },
};

/** LimitRange container defaults per preset. */
export const LIMIT_PRESETS: Record<
  Exclude<SizePreset, 'none'>,
  {
    defaultRequest: Record<string, string>;
    default: Record<string, string>;
    max: Record<string, string>;
  }
> = {
  small: {
    defaultRequest: { cpu: '50m', memory: '64Mi' },
    default: { cpu: '250m', memory: '256Mi' },
    max: { cpu: '1', memory: '1Gi' },
  },
  medium: {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    default: { cpu: '500m', memory: '512Mi' },
    max: { cpu: '4', memory: '8Gi' },
  },
  large: {
    defaultRequest: { cpu: '250m', memory: '256Mi' },
    default: { cpu: '1', memory: '1Gi' },
    max: { cpu: '16', memory: '64Gi' },
  },
};

export function namespaceLabels(input: NamespaceInput): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const p of input.labels) if (p.key.trim()) labels[p.key.trim()] = p.value;
  for (const mode of PSS_MODES) {
    const level = input.pss[mode];
    if (!level) continue;
    labels[`pod-security.kubernetes.io/${mode}`] = level;
    labels[`pod-security.kubernetes.io/${mode}-version`] = 'latest';
  }
  return labels;
}

/** The Namespace first, then the objects that live in it. */
export function buildNamespace(input: NamespaceInput): Record<string, unknown>[] {
  const labels = namespaceLabels(input);
  const out: Record<string, unknown>[] = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: input.name, ...(Object.keys(labels).length ? { labels } : {}) },
    },
  ];
  if (input.quota !== 'none')
    out.push({
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'default-quota', namespace: input.name },
      spec: { hard: QUOTA_PRESETS[input.quota] },
    });
  if (input.limits !== 'none') {
    const preset = LIMIT_PRESETS[input.limits];
    out.push({
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: { name: 'default-limits', namespace: input.name },
      spec: {
        limits: [
          {
            type: 'Container',
            defaultRequest: preset.defaultRequest,
            default: preset.default,
            max: preset.max,
          },
        ],
      },
    });
  }
  return out;
}

export interface NamespaceErrors {
  name: string | null;
  labels: string | null;
  /** A namespace with this name already exists (from the live list). */
  exists: string | null;
}

export function validateNamespace(
  input: NamespaceInput,
  existing: readonly string[],
): NamespaceErrors {
  return {
    name: nameError(input.name, 'label'),
    labels: labelsError(input.labels),
    exists: existing.includes(input.name)
      ? i18n.t('Namespace {name} already exists.', { name: input.name })
      : null,
  };
}

export function namespaceBlocked(errors: NamespaceErrors): boolean {
  return !!errors.name || !!errors.labels || !!errors.exists;
}
