import * as i18n from '@/i18n/core';
import { countLenses, sortRecommendations, type RecSort } from '@/lib/kube/recommendations/model';
import {
  filterRecommendations,
  warningText,
  type RightsizingFilter,
} from '@/lib/kube/rightsizing/model';
import type { RecommendationLens, WorkloadRecommendation } from '@/types';

/**
 * The recommendation list's model (pure): verdict tab counts, lens
 * narrowing and counts, flag chips and checkbox selection. The rows come
 * in scoped to the page's namespaces; everything here narrows them further.
 */

/** Verdict tabs of the list, in order. */
export const VERDICT_FILTERS: readonly RightsizingFilter[] = ['changed', 'over', 'under', 'all'];

/** The rows having every lens in `lenses` (all rows without lenses). */
export function withLenses(
  list: readonly WorkloadRecommendation[],
  lenses: readonly RecommendationLens[],
): WorkloadRecommendation[] {
  if (!lenses.length) return [...list];
  return list.filter((r) => lenses.every((l) => r.lenses?.includes(l)));
}

export interface ListRows {
  /** Rows per verdict tab, the search applied. */
  tabs: Record<RightsizingFilter, number>;
  /**
   * Rows per lens among the rows shown: for a picked lens, the rows shown;
   * for any other, what picking it too would leave.
   */
  lenses: Record<RecommendationLens, number>;
  /** The rows of the tab having every picked lens, sorted. */
  shown: WorkloadRecommendation[];
}

/** What the list shows of the rows in scope for its tab, lenses, sort and search. */
export function listRows(
  rows: readonly WorkloadRecommendation[],
  view: { filter: RightsizingFilter; lenses: readonly RecommendationLens[]; sort: RecSort },
  query: string,
): ListRows {
  const searched = filterRecommendations(rows, 'all', [], query);
  const tabs: Record<RightsizingFilter, number> = {
    changed: 0,
    over: 0,
    under: 0,
    all: searched.length,
  };
  for (const r of searched) {
    if (r.changed) tabs.changed++;
    if (r.verdict === 'over') tabs.over++;
    else if (r.verdict === 'under') tabs.under++;
  }
  const narrowed = withLenses(filterRecommendations(searched, view.filter, [], ''), view.lenses);
  return { tabs, lenses: countLenses(narrowed), shown: sortRecommendations(narrowed, view.sort) };
}

// -- Flags ------------------------------------------------------------------------

export type FlagTone = 'critical' | 'warning' | 'neutral';

export interface RowFlag {
  code: string;
  /** Short chip label. */
  label: string;
  /** Tooltip: the translated caveat with its detail, per container when several have it. */
  detail: string;
  tone: FlagTone;
}

/** Flags the change cells already show as `RaisedTag`. */
const SHOWN_AS_TAG: ReadonlySet<string> = new Set(['cpu-limit-raised', 'memory-limit-raised']);

const TONE_ORDER: Record<FlagTone, number> = { critical: 0, warning: 1, neutral: 2 };

export function flagTone(code: string): FlagTone {
  switch (code) {
    case 'oom-killed':
      return 'critical';
    case 'memory-near-limit':
    case 'cpu-throttled':
    case 'cpu-bursts':
    case 'identity-unclear':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Short label of a warning code; codes of newer strategies stay as they are. */
export function flagLabel(code: string): string {
  switch (code) {
    case 'no-usage':
      return i18n.t('No usage');
    case 'short-history':
      return i18n.t('Short history');
    case 'metrics-server-only':
      return i18n.t('metrics-server only');
    case 'memory-near-limit':
      return i18n.t('Memory near limit');
    case 'cpu-bursts':
      return i18n.t('CPU bursts');
    case 'cpu-limit-raised':
      return i18n.t('CPU limit raised');
    case 'memory-limit-raised':
      return i18n.t('Memory limit raised');
    case 'memory-limit-added':
      return i18n.t('Memory limit added');
    case 'identity-unclear':
      return i18n.t('Identity unclear');
    case 'insufficient-history':
      return i18n.t('Insufficient history');
    case 'low-coverage':
      return i18n.t('Low coverage');
    case 'partial-data':
      return i18n.t('Partial data');
    case 'hpa-target':
      return i18n.t('Autoscaled');
    case 'hpa-utilization':
      return i18n.t('HPA target');
    case 'oom-killed':
      return i18n.t('OOM-killed');
    case 'cpu-throttled':
      return i18n.t('CPU throttled');
    case 'identity-by-name':
      return i18n.t('Matched by name');
    default:
      return code;
  }
}

/**
 * One chip per warning code over the containers (raised limits excepted:
 * the change cells tag them), the most severe first, then in container
 * order. The detail names the container when the workload has several.
 */
export function rowFlags(rec: WorkloadRecommendation): RowFlag[] {
  const several = rec.containers.length > 1;
  const byCode = new Map<string, string[]>();
  for (const c of rec.containers) {
    for (const w of c.warnings) {
      if (SHOWN_AS_TAG.has(w.code)) continue;
      const text = warningText(w);
      const line = several
        ? i18n.t('{container}: {detail}', { container: c.name, detail: text })
        : text;
      const lines = byCode.get(w.code);
      if (!lines) byCode.set(w.code, [line]);
      else if (!lines.includes(line)) lines.push(line);
    }
  }
  return [...byCode.entries()]
    .map(([code, lines], index) => ({
      flag: { code, label: flagLabel(code), detail: lines.join('\n'), tone: flagTone(code) },
      index,
    }))
    .sort((a, b) => TONE_ORDER[a.flag.tone] - TONE_ORDER[b.flag.tone] || a.index - b.index)
    .map((x) => x.flag);
}

// -- Selection --------------------------------------------------------------------

/**
 * Toggles `key`. With `shift` and an anchor still in `order`, every key
 * between the anchor and `key` takes the new state of `key`.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  order: readonly string[],
  key: string,
  anchor: string | null,
  shift: boolean,
): Set<string> {
  const next = new Set(selected);
  const on = !selected.has(key);
  const from = shift && anchor != null ? order.indexOf(anchor) : -1;
  const to = order.indexOf(key);
  if (from >= 0 && to >= 0) {
    for (const k of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      if (on) next.add(k);
      else next.delete(k);
    }
  } else if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** "Select all" of the rows shown: checks them all, or unchecks them when they all are. */
export function toggleAll(selected: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(selected);
  const all = keys.length > 0 && keys.every((k) => selected.has(k));
  for (const k of keys) {
    if (all) next.delete(k);
    else next.add(k);
  }
  return next;
}

/** The checks of keys still present (the same set when none was dropped). */
export function pruneSelection(
  selected: ReadonlySet<string>,
  present: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!selected.size) return selected;
  const next = new Set([...selected].filter((k) => present.has(k)));
  return next.size === selected.size ? selected : next;
}
