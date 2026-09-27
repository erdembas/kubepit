import type { KubeObject } from '@/types';

/**
 * Small typed accessors over raw Kubernetes JSON. `KubeObject.spec/status`
 * are `any` at the contract boundary; everything in the workbench reads
 * them through these helpers so a malformed object degrades to "—" instead
 * of throwing inside a table row.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return fallback;
}

export function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asObject(value))) out[k] = asString(v);
  return out;
}

/** Dotted path lookup: `get(obj, 'spec.template.spec.containers')`. */
export function get(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (isObject(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

export function spec(obj: KubeObject): JsonObject {
  return asObject(obj.spec);
}

export function status(obj: KubeObject): JsonObject {
  return asObject(obj.status);
}

export function field(obj: KubeObject, key: string): unknown {
  return obj[key];
}

export function labels(obj: KubeObject): Record<string, string> {
  return obj.metadata.labels ?? {};
}

export function annotations(obj: KubeObject): Record<string, string> {
  return obj.metadata.annotations ?? {};
}

export function namespaceOf(obj: KubeObject): string | null {
  return obj.metadata.namespace ?? null;
}

export function createdAt(obj: KubeObject): number {
  const t = obj.metadata.creationTimestamp ? Date.parse(obj.metadata.creationTimestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function controllerOf(obj: KubeObject) {
  const refs = obj.metadata.ownerReferences ?? [];
  return refs.find((r) => r.controller) ?? refs[0] ?? null;
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastProbeTime?: string;
  lastHeartbeatTime?: string;
}

export function conditions(obj: KubeObject): Condition[] {
  return asArray(status(obj).conditions)
    .filter(isObject)
    .map((c) => ({
      type: asString(c.type),
      status: asString(c.status),
      reason: asString(c.reason) || undefined,
      message: asString(c.message) || undefined,
      lastTransitionTime: asString(c.lastTransitionTime) || undefined,
      lastProbeTime: asString(c.lastProbeTime) || undefined,
      lastHeartbeatTime: asString(c.lastHeartbeatTime) || undefined,
    }));
}

export function condition(obj: KubeObject, type: string): Condition | undefined {
  return conditions(obj).find((c) => c.type === type);
}

/** `key=value` strings for chips and filters. */
export function labelPairs(map: Record<string, string> | undefined): string[] {
  return Object.entries(map ?? {}).map(([k, v]) => (v ? `${k}=${v}` : k));
}

export function fullName(obj: KubeObject): string {
  return obj.metadata.namespace
    ? `${obj.metadata.namespace}/${obj.metadata.name}`
    : obj.metadata.name;
}

/** Base64 decode that tolerates UTF-8 payloads and bad input. */
export function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return value;
  }
}

export function lastTimestamp(obj: KubeObject): string | undefined {
  return (
    asString(field(obj, 'lastTimestamp')) ||
    asString(field(obj, 'eventTime')) ||
    asString(get(obj, 'series.lastObservedTime')) ||
    asString(field(obj, 'firstTimestamp')) ||
    obj.metadata.creationTimestamp ||
    undefined
  );
}
