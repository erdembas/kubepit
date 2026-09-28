import * as i18n from '@/i18n/core';
import type { LocalFile } from '@/types';
import { base64Size, utf8Size, utf8ToBase64, type KeyValue } from './encoding';
import { checkTlsPair } from './tls';
import { dataKeyError, labelsError, nameError } from './validate';

/**
 * `kubectl create secret` in its five flavours. Values are typed (or
 * loaded) as plain text or files and base64-encoded here; the preview can
 * redact them so nothing is shown in clear after entry.
 */

export type SecretFlavor = 'generic' | 'docker-registry' | 'tls' | 'basic-auth' | 'ssh-auth';

export const SECRET_FLAVORS: readonly SecretFlavor[] = [
  'generic',
  'docker-registry',
  'tls',
  'basic-auth',
  'ssh-auth',
];

export const SECRET_TYPES: Record<SecretFlavor, string> = {
  generic: 'Opaque',
  'docker-registry': 'kubernetes.io/dockerconfigjson',
  tls: 'kubernetes.io/tls',
  'basic-auth': 'kubernetes.io/basic-auth',
  'ssh-auth': 'kubernetes.io/ssh-auth',
};

/** A data value: typed text, or a loaded file (bytes as base64). */
export type SecretValue = { kind: 'text'; text: string } | { kind: 'file'; file: LocalFile };

export interface SecretEntry {
  key: string;
  value: SecretValue;
}

export interface SecretInput {
  flavor: SecretFlavor;
  name: string;
  namespace: string;
  labels: KeyValue[];
  immutable: boolean;
  /** generic */
  entries: SecretEntry[];
  /** docker-registry */
  registry: { server: string; username: string; password: string; email: string };
  /** tls: PEM text (typed or loaded) */
  tls: { cert: SecretValue; key: SecretValue };
  /** basic-auth */
  basic: { username: string; password: string };
  /** ssh-auth */
  ssh: { privateKey: SecretValue; knownHosts: SecretValue };
}

export const DOCKER_HUB = 'https://index.docker.io/v1/';

const EMPTY: SecretValue = { kind: 'text', text: '' };

export function secretDefaults(flavor: SecretFlavor, namespace: string): SecretInput {
  return {
    flavor,
    name: '',
    namespace,
    labels: [],
    immutable: false,
    entries: [{ key: '', value: { kind: 'text', text: '' } }],
    registry: { server: DOCKER_HUB, username: '', password: '', email: '' },
    tls: { cert: EMPTY, key: EMPTY },
    basic: { username: '', password: '' },
    ssh: { privateKey: EMPTY, knownHosts: EMPTY },
  };
}

export function valueBase64(value: SecretValue): string {
  return value.kind === 'text' ? utf8ToBase64(value.text) : value.file.base64;
}

export function valueSize(value: SecretValue): number {
  return value.kind === 'text' ? utf8Size(value.text) : value.file.size;
}

export function valueIsEmpty(value: SecretValue): boolean {
  return value.kind === 'text' ? value.text === '' : false;
}

/** Text of a value (files decoded as UTF-8); '' when it is not text. */
export function valueText(value: SecretValue): string {
  if (value.kind === 'text') return value.text;
  if (!value.file.utf8) return '';
  try {
    const binary = atob(value.file.base64);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

/** `.dockerconfigjson` the way `kubectl create secret docker-registry` writes it. */
export function dockerConfigJson(r: SecretInput['registry']): string {
  const entry: Record<string, string> = {
    username: r.username,
    password: r.password,
    ...(r.email.trim() ? { email: r.email.trim() } : {}),
    auth: utf8ToBase64(`${r.username}:${r.password}`),
  };
  return JSON.stringify({ auths: { [r.server.trim() || DOCKER_HUB]: entry } });
}

/** Data keys → base64 values for the flavor. */
export function secretData(input: SecretInput): Record<string, string> {
  switch (input.flavor) {
    case 'generic': {
      const out: Record<string, string> = {};
      for (const e of input.entries) if (e.key.trim()) out[e.key.trim()] = valueBase64(e.value);
      return out;
    }
    case 'docker-registry':
      return { '.dockerconfigjson': utf8ToBase64(dockerConfigJson(input.registry)) };
    case 'tls':
      return { 'tls.crt': valueBase64(input.tls.cert), 'tls.key': valueBase64(input.tls.key) };
    case 'basic-auth':
      return {
        username: utf8ToBase64(input.basic.username),
        password: utf8ToBase64(input.basic.password),
      };
    case 'ssh-auth': {
      const out: Record<string, string> = { 'ssh-privatekey': valueBase64(input.ssh.privateKey) };
      if (!valueIsEmpty(input.ssh.knownHosts)) out.known_hosts = valueBase64(input.ssh.knownHosts);
      return out;
    }
  }
}

/** Placeholder shown instead of a value in redacted previews. */
export function redactedValue(b64: string): string {
  const size = base64Size(b64);
  return `<${i18n.plural('hidden, {count} byte', 'hidden, {count} bytes', size)}>`;
}

/**
 * The Secret. With `redact`, every data value is replaced by a size
 * placeholder (the preview); the editor always gets the real object.
 */
export function buildSecret(input: SecretInput, { redact = false } = {}): Record<string, unknown> {
  const data = secretData(input);
  const labels: Record<string, string> = {};
  for (const p of input.labels) if (p.key.trim()) labels[p.key.trim()] = p.value;
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      ...(Object.keys(labels).length ? { labels } : {}),
    },
    type: SECRET_TYPES[input.flavor],
    ...(input.immutable ? { immutable: true } : {}),
    data: redact
      ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, redactedValue(v)]))
      : data,
  };
}

// -- Validation -------------------------------------------------------------------

const MAX_TOTAL = 1024 * 1024;

export interface SecretErrors {
  name: string | null;
  labels: string | null;
  /** Per generic entry: key problem. */
  entries: Array<string | null>;
  /** Flavor-specific fields, by field id. */
  fields: Record<string, string | null>;
  /** Blocking problem that belongs to no single field. */
  general: string | null;
}

export function validateSecret(input: SecretInput): SecretErrors {
  const fields: Record<string, string | null> = {};
  const entries: Array<string | null> = [];
  let general: string | null = null;
  switch (input.flavor) {
    case 'generic': {
      const seen = new Set<string>();
      for (const e of input.entries) {
        const key = e.key.trim();
        let error = dataKeyError(key);
        if (!error && seen.has(key)) error = i18n.t('Duplicate key {key}.', { key });
        seen.add(key);
        entries.push(error);
      }
      if (!input.entries.length) general = i18n.t('Add at least one key.');
      break;
    }
    case 'docker-registry':
      fields.server = input.registry.server.trim()
        ? null
        : i18n.t('A registry server is required.');
      fields.username = input.registry.username ? null : i18n.t('A username is required.');
      fields.password = input.registry.password
        ? null
        : i18n.t('A password or access token is required.');
      fields.email =
        input.registry.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(input.registry.email.trim())
          ? i18n.t('This does not look like an e-mail address.')
          : null;
      break;
    case 'tls': {
      const check = checkTlsPair(valueText(input.tls.cert), valueText(input.tls.key));
      fields.cert = check.certError;
      fields.key = check.keyError;
      if (check.match === 'mismatch')
        general =
          check.matchesIndex !== null
            ? i18n.t(
                'The key belongs to certificate {index} of the chain; put that certificate first.',
                { index: check.matchesIndex },
              )
            : i18n.t('The private key does not belong to the certificate.');
      break;
    }
    case 'basic-auth':
      fields.username =
        input.basic.username || input.basic.password
          ? null
          : i18n.t('Enter a username, a password or both.');
      break;
    case 'ssh-auth': {
      const text = valueText(input.ssh.privateKey);
      fields.privateKey = !text.trim()
        ? i18n.t('No private key yet.')
        : /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
          ? null
          : i18n.t('No PEM or OpenSSH private key block found.');
      break;
    }
  }
  const total = Object.values(secretData(input)).reduce((n, v) => n + v.length, 0);
  if (!general && total > MAX_TOTAL)
    general = i18n.t('The Secret is larger than 1 MiB; the API server will reject it.');
  return {
    name: nameError(input.name),
    labels: labelsError(input.labels),
    entries,
    fields,
    general,
  };
}

export function secretBlocked(errors: SecretErrors): boolean {
  return (
    !!errors.name ||
    !!errors.labels ||
    !!errors.general ||
    errors.entries.some(Boolean) ||
    Object.values(errors.fields).some(Boolean)
  );
}
