import * as i18n from '@/i18n/core';
import type { KeyRef, PrometheusAccess, PrometheusConfig } from '@/types';

/**
 * Form state and client-side checks of `ClusterDef.prometheus_access` (a
 * shared or secured Prometheus), mirroring
 * `kubepit-core/src/prometheus/access.rs` (the backend validates again on
 * save). Only Secret *references* live here; the values never reach the UI.
 * Pure.
 */

/** Labels the presets select or group by (`RESERVED_LABELS` in the backend). */
export const RESERVED_LABELS = [
  '__name__',
  'namespace',
  'pod',
  'container',
  'resource',
  'uid',
  'owner_name',
  'owner_kind',
  'job',
  'instance',
  'replicaset',
  'job_name',
  'reason',
] as const;

export const MAX_TENANT_LEN = 200;

export type AccessAuthKind = 'none' | 'bearer' | 'basic';
export type AccessCaKind = 'system' | KeyRef['kind'];

export interface LabelRow {
  name: string;
  value: string;
}

export interface AccessDraft {
  tenant: string;
  labels: LabelRow[];
  auth: AccessAuthKind;
  secretNamespace: string;
  secretName: string;
  tokenKey: string;
  usernameKey: string;
  passwordKey: string;
  ca: AccessCaKind;
  caNamespace: string;
  caName: string;
  caKey: string;
  skipVerify: boolean;
}

export function accessDraft(access: PrometheusAccess | undefined): AccessDraft {
  const auth = access?.auth ?? null;
  const ca = access?.tls?.ca ?? null;
  return {
    tenant: access?.tenant ?? '',
    labels: Object.entries(access?.cluster_labels ?? {}).map(([name, value]) => ({ name, value })),
    auth: auth?.type ?? 'none',
    secretNamespace: auth?.namespace ?? 'monitoring',
    secretName: auth?.secret ?? '',
    tokenKey: auth?.type === 'bearer' ? auth.token_key : 'token',
    usernameKey: auth?.type === 'basic' ? auth.username_key : 'username',
    passwordKey: auth?.type === 'basic' ? auth.password_key : 'password',
    ca: ca?.kind ?? 'system',
    caNamespace: ca?.namespace ?? 'monitoring',
    caName: ca?.name ?? '',
    caKey: ca?.key ?? 'ca.crt',
    skipVerify: access?.tls?.insecure_skip_verify ?? false,
  };
}

/** Anything set that changes how Prometheus is reached. */
export function accessConfigured(access: PrometheusAccess | undefined): boolean {
  return Boolean(
    access &&
    (access.tenant.trim() ||
      Object.keys(access.cluster_labels).length ||
      access.auth ||
      access.tls),
  );
}

/**
 * Credentials go only to a service chosen in the cluster settings, never to
 * a detected one (anyone who may create a Service named like a Prometheus
 * would be a candidate). The backend enforces the same rule.
 */
export function credentialsAllowed(config: PrometheusConfig): boolean {
  return config.mode === 'service';
}

/** `access` without credentials and tunnel TLS (Prometheus off or detected). */
export function withoutCredentials(
  access: PrometheusAccess | undefined,
): PrometheusAccess | undefined {
  return access && { ...access, auth: null, tls: null };
}

/**
 * Whether the tunnel's TLS settings apply: credentials are set for a chosen
 * service that speaks https.
 */
export function tlsApplies(draft: AccessDraft, config: PrometheusConfig): boolean {
  return (
    draft.auth !== 'none' &&
    credentialsAllowed(config) &&
    config.mode === 'service' &&
    config.scheme === 'https'
  );
}

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const VISIBLE_ASCII = /^[\x21-\x7e]*$/;

/** A DNS-1123 style namespace or object name (`valid_name` in the backend). */
export function validName(value: string): boolean {
  return value.length > 0 && value.length <= 253 && /^[a-z0-9.-]+$/.test(value);
}

/** A ConfigMap or Secret data key (Kubernetes' key rules). */
export function validKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value !== '.' &&
    value !== '..' &&
    /^[-._a-zA-Z0-9]+$/.test(value)
  );
}

/** The problem with one label row, or null (empty rows are ignored). */
export function labelProblem(row: LabelRow): string | null {
  const name = row.name.trim();
  const value = row.value.trim();
  if (!name && !value) return null;
  if (!LABEL_NAME.test(name))
    return i18n.t(
      '"{name}" is not a label name: use letters, digits and _, not starting with a digit.',
      { name },
    );
  if ((RESERVED_LABELS as readonly string[]).includes(name))
    return i18n.t('The label {name} is used by Kubepit’s own queries; choose another one.', {
      name,
    });
  if (!value || CONTROL.test(value)) return i18n.t('Enter a value for the label {name}.', { name });
  return null;
}

/**
 * The setting to save, or a translated message explaining what is wrong.
 * `config` decides whether the TLS settings apply.
 */
export function accessFromDraft(
  draft: AccessDraft,
  config: PrometheusConfig,
): { access: PrometheusAccess } | { error: string } {
  const tenant = draft.tenant.trim();
  // A header value (`X-Scope-OrgID`): visible ASCII, like the backend requires.
  if (tenant.length > MAX_TENANT_LEN || !VISIBLE_ASCII.test(tenant))
    return {
      error: i18n.t('The tenant must be at most {count} visible ASCII characters (no spaces).', {
        count: MAX_TENANT_LEN,
      }),
    };
  const cluster_labels: Record<string, string> = {};
  for (const row of draft.labels) {
    const problem = labelProblem(row);
    if (problem) return { error: problem };
    const name = row.name.trim();
    if (!name) continue;
    if (name in cluster_labels)
      return { error: i18n.t('The label {name} is set twice.', { name }) };
    cluster_labels[name] = row.value.trim();
  }
  const key = (value: string) => value.trim();
  let auth: PrometheusAccess['auth'] = null;
  // Hidden and dropped unless a service is chosen (see `credentialsAllowed`).
  if (draft.auth !== 'none' && credentialsAllowed(config)) {
    const namespace = key(draft.secretNamespace);
    const secret = key(draft.secretName);
    if (!validName(namespace))
      return { error: i18n.t('Enter the namespace of the credentials Secret.') };
    if (!validName(secret)) return { error: i18n.t('Enter the name of the credentials Secret.') };
    const keys =
      draft.auth === 'bearer' ? [draft.tokenKey] : [draft.usernameKey, draft.passwordKey];
    if (!keys.every((k) => validKey(key(k))))
      return {
        error: i18n.t('Enter the Secret keys (letters, digits, -, _ and . only).'),
      };
    auth =
      draft.auth === 'bearer'
        ? { type: 'bearer', namespace, secret, token_key: key(draft.tokenKey) }
        : {
            type: 'basic',
            namespace,
            secret,
            username_key: key(draft.usernameKey),
            password_key: key(draft.passwordKey),
          };
  }
  let tls: PrometheusAccess['tls'] = null;
  if (tlsApplies(draft, config)) {
    let ca: KeyRef | null = null;
    if (draft.ca !== 'system' && !draft.skipVerify) {
      const namespace = key(draft.caNamespace);
      const name = key(draft.caName);
      if (!validName(namespace) || !validName(name))
        return { error: i18n.t('Enter the namespace and name of the CA ConfigMap or Secret.') };
      if (!validKey(key(draft.caKey)))
        return { error: i18n.t('Enter the key of the CA certificate.') };
      ca = { kind: draft.ca, namespace, name, key: key(draft.caKey) };
    }
    if (ca || draft.skipVerify) tls = { ca, insecure_skip_verify: draft.skipVerify };
  }
  return { access: { tenant, cluster_labels, auth, tls } };
}

/**
 * The selector the backend adds to every preset, as it appears in PromQL
 * (`cluster="prod",region="eu"`, sorted by name, quoted like PromQL
 * strings); '' without labels.
 */
export function clusterMatchers(access: PrometheusAccess | undefined): string {
  const quote = (value: string) =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  return Object.entries(access?.cluster_labels ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(',');
}

/** Stable cache-key fragment of the access settings. */
export function accessKey(access: PrometheusAccess | undefined): string {
  if (!accessConfigured(access)) return '';
  const a = access!;
  return JSON.stringify([
    a.tenant,
    Object.entries(a.cluster_labels).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    a.auth,
    a.tls,
  ]);
}
