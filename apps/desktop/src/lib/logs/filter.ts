import { LEVEL_KEYS, levelKey, type LevelKey, type LogLevel } from './levels';

/**
 * Filters of the structured log view: field filters (`key=value`,
 * `key!=value`, `key~regex`, `key!~regex`), the level set and free text.
 * Pure: the view supplies a getter per record.
 */

export type FieldOp = '=' | '!=' | '~' | '!~';

export interface FieldFilter {
  key: string;
  op: FieldOp;
  value: string;
}

const FILTER_RE = /^\s*([\w.@/:-]+?)\s*(!=|!~|=|~)\s*(.*?)\s*$/s;

/** `level=error`, `status!=200`, `path~^/api`, `msg!~health` → filter; null otherwise. */
export function parseFieldFilter(input: string): FieldFilter | null {
  const m = FILTER_RE.exec(input);
  if (!m) return null;
  let value = m[3]!;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return { key: m[1]!, op: m[2] as FieldOp, value };
}

export function formatFieldFilter(filter: FieldFilter): string {
  const value = /\s/.test(filter.value) || filter.value === '' ? `"${filter.value}"` : filter.value;
  return `${filter.key}${filter.op}${value}`;
}

export function sameFilter(a: FieldFilter, b: FieldFilter): boolean {
  return a.key === b.key && a.op === b.op && a.value === b.value;
}

/** Reads a field of one record (`undefined` = the record has no such field). */
export type FieldGetter = (key: string) => string | undefined;

export interface CompiledFilters {
  /** Filters whose regex does not compile (shown as errors, ignored). */
  invalid: FieldFilter[];
  test: (get: FieldGetter) => boolean;
}

/** One predicate for every filter (all must match). */
export function compileFieldFilters(filters: readonly FieldFilter[]): CompiledFilters {
  const invalid: FieldFilter[] = [];
  const tests: Array<(get: FieldGetter) => boolean> = [];
  for (const f of filters) {
    if (f.op === '=' || f.op === '!=') {
      const want = f.value;
      const negate = f.op === '!=';
      tests.push((get) => ((get(f.key) ?? '') === want) !== negate);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(f.value, 'i');
    } catch {
      invalid.push(f);
      continue;
    }
    const negate = f.op === '!~';
    tests.push((get) => re.test(get(f.key) ?? '') !== negate);
  }
  return {
    invalid,
    test: tests.length === 0 ? () => true : (get) => tests.every((t) => t(get)),
  };
}

/** Case-insensitive substring test; empty text matches everything. */
export function textMatcher(text: string): (haystack: string) => boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return () => true;
  return (haystack) => haystack.toLowerCase().includes(needle);
}

/** Level set of the filter chips: every level shown by default. */
export type LevelSet = ReadonlySet<LevelKey>;

export const ALL_LEVELS: LevelSet = new Set(LEVEL_KEYS);

export function levelVisible(levels: LevelSet, level: LogLevel | null | undefined): boolean {
  return levels.size === LEVEL_KEYS.length || levels.has(levelKey(level));
}

/** Toggle one level; toggling the only visible level shows everything again. */
export function toggleLevel(levels: LevelSet, key: LevelKey): LevelSet {
  const next = new Set(levels);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next.size === 0 ? ALL_LEVELS : next;
}

/** Show only `key` (or everything when it already is the only one). */
export function onlyLevel(levels: LevelSet, key: LevelKey): LevelSet {
  return levels.size === 1 && levels.has(key) ? ALL_LEVELS : new Set([key]);
}

/** Levels at or above `level` (plus records without a level). */
export function levelsAtLeast(level: LogLevel): LevelSet {
  const from = LEVEL_KEYS.indexOf(level);
  return new Set(LEVEL_KEYS.filter((k, i) => k === 'none' || i >= from));
}
