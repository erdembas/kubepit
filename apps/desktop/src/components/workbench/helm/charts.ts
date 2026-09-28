import * as i18n from '@/i18n/core';
import YAML from 'yaml';
import { create } from 'zustand';

/** Pure helpers and UI state shared by the Helm chart screens. */

/** Tinted monogram tones (theme tokens), picked deterministically per chart. */
const TONES = [
  'bg-cat-frontend/12 text-cat-frontend',
  'bg-cat-backend/12 text-cat-backend',
  'bg-cat-database/12 text-cat-database',
  'bg-cat-infra/12 text-cat-infra',
  'bg-cat-worker/12 text-cat-worker',
  'bg-cat-tooling/12 text-cat-tooling',
  'bg-tone-info/12 text-tone-info-fg',
];

export function chartTone(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length]!;
}

/** `kube-prometheus-stack` → `KP`, `nginx` → `NG`. */
export function chartInitials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return (parts[0] ?? name).slice(0, 2).toUpperCase();
}

/** Chart name from an Artifact Hub package URL (`…/packages/helm/<repo>/<chart>`). */
export function hubChartName(url: string): string {
  return url.replace(/\/+$/, '').split('/').pop() ?? url;
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Helm's release-name rule (DNS-1123 subdomain, ≤ 53). `null` when valid. */
export function releaseNameError(name: string): string | null {
  if (!name) return i18n.t('A release name is required.');
  if (name.length > 53) return i18n.t('Use at most 53 characters.');
  if (!name.split('.').every((part) => DNS_LABEL.test(part)))
    return i18n.t(
      'Use lowercase letters, digits, "-" and ".", starting and ending with a letter or digit.',
    );
  return null;
}

export function namespaceError(name: string): string | null {
  if (!name) return i18n.t('Choose a namespace.');
  if (name.length > 63 || !DNS_LABEL.test(name))
    return i18n.t('Use lowercase letters, digits and "-" (at most 63 characters).');
  return null;
}

/** YAML check for user values: must be a mapping (or empty). `null` when valid. */
export function valuesError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) return doc.errors[0]!.message.split('\n')[0]!;
    const value: unknown = doc.toJS();
    if (value != null && (typeof value !== 'object' || Array.isArray(value)))
      return i18n.t('Values must be a YAML mapping.');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Same document ignoring formatting and comments (for "edited?" checks). */
export function sameValues(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(YAML.parse(a) ?? {}) === JSON.stringify(YAML.parse(b) ?? {});
  } catch {
    return false;
  }
}

export interface ManifestResource {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  /** Normalised YAML of the document (for change detection). */
  text: string;
}

/** Objects of a rendered multi-document manifest (non-objects are skipped). */
export function parseManifest(manifest: string): ManifestResource[] {
  const out: ManifestResource[] = [];
  for (const doc of YAML.parseAllDocuments(manifest)) {
    if (doc.errors.length) continue;
    const value = doc.toJS() as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') continue;
    const meta = (value.metadata ?? {}) as { name?: string; namespace?: string };
    if (typeof value.kind !== 'string' || !meta.name) continue;
    out.push({
      apiVersion: String(value.apiVersion ?? ''),
      kind: value.kind,
      name: meta.name,
      namespace: meta.namespace ?? null,
      text: JSON.stringify(value),
    });
  }
  return out;
}

export function groupByKind(resources: ManifestResource[]): Array<[string, ManifestResource[]]> {
  const groups = new Map<string, ManifestResource[]>();
  for (const r of resources) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function isHelmMissingError(error: string | null | undefined): boolean {
  return !!error && /helm was not found/i.test(error);
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// UI state (charts are not cluster-specific, so this is global)
// ---------------------------------------------------------------------------

export type ChartSource = 'repos' | 'hub';

interface ChartsUi {
  source: ChartSource;
  /** Repository filter ('' = all). */
  repo: string;
  query: string;
  /** Last submitted Artifact Hub query. */
  hubQuery: string;
  set: (patch: Partial<Omit<ChartsUi, 'set'>>) => void;
}

export const useChartsUi = create<ChartsUi>()((set) => ({
  source: 'repos',
  repo: '',
  query: '',
  hubQuery: '',
  set: (patch) => set(patch),
}));

/** Polled-cache keys shared by the chart screens. */
export const CHART_KEYS = {
  repos: 'helm-charts|repos',
  catalog: 'helm-charts|catalog',
  versions: (ref: string) => `helm-charts|versions|${ref}`,
  show: (ref: string, version: string | null) => `helm-charts|show|${ref}|${version ?? ''}`,
  schema: (ref: string, version: string | null) => `helm-charts|schema|${ref}|${version ?? ''}`,
  hub: (query: string) => `helm-charts|hub|${query}`,
};
