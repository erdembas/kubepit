import * as i18n from '@/i18n/core';
import type { KeyValue } from './encoding';

/**
 * Field validation for the wizards, mirroring the API server's rules
 * (apimachinery `validation`). Every function returns a translated message
 * or null; the server remains the final judge (the review is a dry run).
 */

const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1035 = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Object names. `subdomain` (most kinds): lowercase DNS subdomain, ≤ 253.
 * `label` (Namespaces): DNS label, ≤ 63. `dns1035` (Services): a label that
 * starts with a letter.
 */
export function nameError(
  name: string,
  rule: 'subdomain' | 'label' | 'dns1035' = 'subdomain',
  max?: number,
): string | null {
  if (!name) return i18n.t('A name is required.');
  const limit = max ?? (rule === 'subdomain' ? 253 : 63);
  if (name.length > limit) return i18n.t('Use at most {count} characters.', { count: limit });
  if (rule === 'subdomain') {
    if (name.split('.').every((part) => LABEL.test(part))) return null;
    return i18n.t(
      'Use lowercase letters, digits, "-" and "."; start and end with a letter or digit.',
    );
  }
  if (rule === 'dns1035') {
    if (DNS1035.test(name)) return null;
    return i18n.t('Use lowercase letters, digits and "-"; start with a letter.');
  }
  if (LABEL.test(name)) return null;
  return i18n.t('Use lowercase letters, digits and "-"; start and end with a letter or digit.');
}

/** ConfigMap / Secret data keys. */
export function dataKeyError(key: string): string | null {
  if (!key) return i18n.t('A key is required.');
  if (key.length > 253) return i18n.t('Use at most {count} characters.', { count: 253 });
  if (key === '.' || key === '..' || !/^[-._a-zA-Z0-9]+$/.test(key))
    return i18n.t('Keys may contain letters, digits, "-", "_" and ".".');
  return null;
}

const QUALIFIED_NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;

/** Label and annotation keys: `[prefix/]name`. */
export function labelKeyError(key: string): string | null {
  if (!key) return i18n.t('A key is required.');
  const slash = key.lastIndexOf('/');
  const prefix = slash >= 0 ? key.slice(0, slash) : '';
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  if (slash >= 0 && (!prefix || prefix.length > 253 || nameError(prefix) !== null))
    return i18n.t('The prefix must be a DNS subdomain, like example.com.');
  if (!name || name.length > 63 || !QUALIFIED_NAME.test(name))
    return i18n.t(
      'Use at most 63 letters, digits, "-", "_" and "."; start and end with a letter or digit.',
    );
  return null;
}

export function labelValueError(value: string): string | null {
  if (value === '') return null;
  if (value.length > 63 || !QUALIFIED_NAME.test(value))
    return i18n.t(
      'Use at most 63 letters, digits, "-", "_" and "."; start and end with a letter or digit.',
    );
  return null;
}

/** First problem of a label map, or null. */
export function labelsError(pairs: readonly KeyValue[]): string | null {
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = p.key.trim();
    if (!key && !p.value) continue;
    const error = labelKeyError(key) ?? labelValueError(p.value);
    if (error) return i18n.t('{key}: {message}', { key: key || '…', message: error });
    if (seen.has(key)) return i18n.t('Duplicate key {key}.', { key });
    seen.add(key);
  }
  return null;
}

export function portNumberError(value: string, { optional = false } = {}): string | null {
  if (!value.trim()) return optional ? null : i18n.t('A port is required.');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return i18n.t('Use a port between 1 and 65535.');
  return null;
}

/** IANA service names (named ports): ≤ 15 lowercase letters, digits and "-". */
export function portNameError(name: string): string | null {
  if (!name) return null;
  if (
    name.length > 15 ||
    !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) ||
    name.includes('--') ||
    !/[a-z]/.test(name)
  )
    return i18n.t(
      'Port names have at most 15 lowercase letters, digits and "-", with at least one letter.',
    );
  return null;
}

/** A target port: a number or a named container port. */
export function targetPortError(value: string): string | null {
  if (!value.trim()) return i18n.t('A port is required.');
  return /^\d+$/.test(value) ? portNumberError(value) : portNameError(value);
}

/** Host names of Ingress rules (wildcards allowed as the first label). */
export function hostError(host: string): string | null {
  if (!host) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return i18n.t('Hosts must be names, not IP addresses.');
  const rest = host.startsWith('*.') ? host.slice(2) : host;
  if (rest.length > 253 || !rest.split('.').every((part) => LABEL.test(part)))
    return i18n.t('Use a lowercase DNS name, like app.example.com or *.example.com.');
  return null;
}
