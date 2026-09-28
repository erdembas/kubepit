import YAML from 'yaml';

/**
 * Base64 and YAML helpers shared by the resource wizards. Secret values
 * are encoded here so users type plain text and never deal with base64.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  try {
    const binary = atob(clean);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** UTF-8 text of base64 content, or null when it is not valid UTF-8. */
export function base64ToUtf8(b64: string): string | null {
  const bytes = base64ToBytes(b64);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decoded size of standard base64. */
export function base64Size(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

export function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A manifest: one YAML document per object, separated by `---`. */
export function manifestYaml(objects: readonly object[]): string {
  return objects.map((o) => YAML.stringify(o, { lineWidth: 0 })).join('---\n');
}

/** Drops keys whose value is `undefined`, empty objects/arrays or empty strings (recursively). */
export function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune).filter((v) => !isEmpty(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const pruned = prune(v);
      if (!isEmpty(pruned)) out[k] = pruned;
    }
    return out as T;
  }
  return value;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** Key/value rows (form state) → a map, skipping rows without a key. */
export function pairsToMap(pairs: readonly KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.key.trim()) out[p.key.trim()] = p.value;
  return out;
}

export function mapToPairs(map: Record<string, string> | undefined): KeyValue[] {
  return Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
}

export interface KeyValue {
  key: string;
  value: string;
}
