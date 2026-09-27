import type { KubeObject, ObjectMeta } from '@/types';

/** Deterministic helpers shared by the demo fixtures. */

export const BOOT = Date.now();
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const iso = (ms: number) => new Date(ms).toISOString();
/** Timestamp `ms` before the demo backend booted (stable ages while browsing). */
export const ago = (ms: number) => iso(BOOT - ms);
export const nowIso = () => iso(Date.now());

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny seeded PRNG so every cluster renders the same demo data. */
export function seeded(seed: string) {
  let a = hashString(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;

export const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
export const between = (r: Rand, min: number, max: number) =>
  min + Math.floor(r() * (max - min + 1));

const ALNUM = 'bcdfghjklmnpqrstvwxz2456789';
export function suffix(r: Rand, n = 5) {
  let out = '';
  for (let i = 0; i < n; i++) out += ALNUM[Math.floor(r() * ALNUM.length)];
  return out;
}

export function hexId(r: Rand, n: number) {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(r() * 16).toString(16);
  return out;
}

export function b64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface MetaInput {
  name: string;
  namespace?: string | null;
  age?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  owner?: KubeObject | null;
  finalizers?: string[];
}

/** Builds metadata; uid + resourceVersion are filled by the DB on insert. */
export function meta(input: MetaInput): ObjectMeta {
  const m: ObjectMeta = {
    name: input.name,
    uid: '',
    creationTimestamp: ago(input.age ?? 30 * DAY),
  };
  if (input.namespace) m.namespace = input.namespace;
  if (input.labels && Object.keys(input.labels).length) m.labels = input.labels;
  if (input.annotations && Object.keys(input.annotations).length) m.annotations = input.annotations;
  if (input.finalizers?.length) m.finalizers = input.finalizers;
  if (input.owner) {
    m.ownerReferences = [
      {
        apiVersion: input.owner.apiVersion,
        kind: input.owner.kind,
        name: input.owner.metadata.name,
        uid: input.owner.metadata.uid,
        controller: true,
      },
    ];
  }
  return m;
}

export function obj(
  apiVersion: string,
  kind: string,
  metadata: ObjectMeta,
  rest: Record<string, unknown> = {},
): KubeObject {
  return { apiVersion, kind, metadata, ...rest };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** RFC 7386 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> =
    typeof target === 'object' && target !== null && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}
