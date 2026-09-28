import * as i18n from '@/i18n/core';
import type { LocalFile } from '@/types';
import { base64ToUtf8, utf8Size, type KeyValue } from './encoding';
import { dataKeyError, labelsError, nameError } from './validate';

/**
 * `kubectl create configmap`: literals, files (one key per file; files
 * that are not UTF-8 go to `binaryData`, like kubectl) and `.env` imports.
 */

export type ConfigValue = { kind: 'text'; text: string } | { kind: 'file'; file: LocalFile };

export interface ConfigEntry {
  key: string;
  value: ConfigValue;
}

export interface ConfigMapInput {
  name: string;
  namespace: string;
  labels: KeyValue[];
  immutable: boolean;
  entries: ConfigEntry[];
}

export function configMapDefaults(namespace: string): ConfigMapInput {
  return {
    name: '',
    namespace,
    labels: [],
    immutable: false,
    entries: [{ key: '', value: { kind: 'text', text: '' } }],
  };
}

/** A data key for a file name (`kubectl` uses the base name as-is). */
export function keyForFile(name: string): string {
  const cleaned = name.replace(/[^-._a-zA-Z0-9]/g, '_');
  return cleaned === '.' || cleaned === '..' || !cleaned ? 'file' : cleaned;
}

export interface EnvParse {
  entries: KeyValue[];
  /** 1-based lines that are not `KEY=VALUE`. */
  invalid: number[];
}

/**
 * `.env` files: `KEY=VALUE` per line, `#` comments, optional `export`,
 * surrounding single or double quotes removed (double-quoted values
 * understand `\n`, `\t`, `\"` and `\\`). Later duplicates win, like dotenv.
 */
export function parseEnvFile(text: string): EnvParse {
  const values = new Map<string, string>();
  const invalid: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      invalid.push(index + 1);
      return;
    }
    let value = m[2] ?? '';
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"')
        value = value.replace(/\\([nrt"\\])/g, (_, c: string) =>
          c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
        );
    } else {
      // Unquoted values end at an inline comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.delete(m[1]!);
    values.set(m[1]!, value);
  });
  return { entries: [...values].map(([key, value]) => ({ key, value })), invalid };
}

/** Text of a file value, or null when it is binary. */
export function fileText(file: LocalFile): string | null {
  return file.utf8 ? base64ToUtf8(file.base64) : null;
}

export function buildConfigMap(input: ConfigMapInput): Record<string, unknown> {
  const data: Record<string, string> = {};
  const binaryData: Record<string, string> = {};
  for (const e of input.entries) {
    const key = e.key.trim();
    if (!key) continue;
    if (e.value.kind === 'text') data[key] = e.value.text;
    else {
      const text = fileText(e.value.file);
      if (text === null) binaryData[key] = e.value.file.base64;
      else data[key] = text;
    }
  }
  const labels: Record<string, string> = {};
  for (const p of input.labels) if (p.key.trim()) labels[p.key.trim()] = p.value;
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      ...(Object.keys(labels).length ? { labels } : {}),
    },
    ...(input.immutable ? { immutable: true } : {}),
    ...(Object.keys(data).length ? { data } : {}),
    ...(Object.keys(binaryData).length ? { binaryData } : {}),
  };
}

export interface ConfigMapErrors {
  name: string | null;
  labels: string | null;
  entries: Array<string | null>;
  general: string | null;
}

const MAX_TOTAL = 1024 * 1024;

export function entrySize(value: ConfigValue): number {
  return value.kind === 'text' ? utf8Size(value.text) : value.file.size;
}

export function validateConfigMap(input: ConfigMapInput): ConfigMapErrors {
  const seen = new Set<string>();
  const entries = input.entries.map((e) => {
    const key = e.key.trim();
    const error = dataKeyError(key);
    if (error) return error;
    if (seen.has(key)) return i18n.t('Duplicate key {key}.', { key });
    seen.add(key);
    return null;
  });
  const total = input.entries.reduce((n, e) => n + entrySize(e.value), 0);
  return {
    name: nameError(input.name),
    labels: labelsError(input.labels),
    entries,
    general:
      total > MAX_TOTAL
        ? i18n.t('The ConfigMap is larger than 1 MiB; the API server will reject it.')
        : null,
  };
}

export function configMapBlocked(errors: ConfigMapErrors): boolean {
  return !!errors.name || !!errors.labels || !!errors.general || errors.entries.some(Boolean);
}
