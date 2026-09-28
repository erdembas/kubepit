import { toCsv } from '@/lib/tableExport';
import type { LogLevel } from './levels';
import { parsedRecord, recordText, type LogRecord } from './records';

/**
 * Glue of the structured log view (pure): the field getter filters use,
 * field discovery for the column picker, and the JSON lines / CSV export
 * of the filtered records.
 */

/** Source-level fields of a record: `pod`, `container`, Loki stream labels… */
export type SourceFields = (record: LogRecord) => Record<string, string> | undefined;

/** Built-in keys every record answers. */
export const BUILTIN_KEYS = ['level', 'message', 'msg', 'source', 'raw'] as const;

function display(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** A flattened path (`a.b.c`) inside a decoded JSON line. */
function lookupPath(obj: Record<string, unknown>, path: string): unknown {
  if (path in obj) return obj[path];
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Reads `key` of `record` for field filters. */
export function recordField(
  record: LogRecord,
  key: string,
  sourceFields: SourceFields | undefined,
  sourceLabel: ((record: LogRecord) => string) | undefined,
): string | undefined {
  switch (key) {
    case 'level':
      return record.level ?? '';
    case 'message':
    case 'msg': {
      const parsed = parsedRecord(record);
      return parsed.message || recordText(record);
    }
    case 'source':
      return sourceLabel?.(record);
    case 'raw':
    case 'line':
      return recordText(record);
    case 'time': {
      const time = parsedRecord(record).time;
      return time === null ? undefined : new Date(time).toISOString();
    }
  }
  const parsed = parsedRecord(record);
  if (key in parsed.fields) return parsed.fields[key];
  const source = sourceFields?.(record)?.[key];
  if (source !== undefined) return source;
  if (parsed.json) {
    const value = lookupPath(parsed.json, key);
    if (value !== undefined) return display(value);
  }
  return undefined;
}

/**
 * Field keys found in the newest `sample` records, most frequent first
 * (ties by name). Level, time and message keys are not fields.
 */
export function discoverFields(
  records: readonly LogRecord[],
  sample = 1_500,
): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  const from = Math.max(0, records.length - sample);
  for (let i = from; i < records.length; i++) {
    for (const key of Object.keys(parsedRecord(records[i]!).fields))
      counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface ExportContext {
  sourceLabel?: (record: LogRecord) => string;
  sourceFields?: SourceFields;
}

interface ExportRow {
  time: string | null;
  level: LogLevel | null;
  source?: string;
  message: string;
  fields: Record<string, string>;
}

function exportRow(record: LogRecord, ctx: ExportContext): ExportRow {
  const parsed = parsedRecord(record);
  const text = recordText(record);
  const rest = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
  const message = parsed.message || text.split('\n', 1)[0]!;
  const row: ExportRow = {
    time: parsed.time === null ? null : new Date(parsed.time).toISOString(),
    level: record.level,
    message: rest ? `${message}\n${rest}` : message,
    fields: { ...ctx.sourceFields?.(record), ...parsed.fields },
  };
  if (ctx.sourceLabel) row.source = ctx.sourceLabel(record);
  return row;
}

/** One JSON object per record: `{time, level, source?, message, fields}`. */
export function recordsToJsonLines(records: readonly LogRecord[], ctx: ExportContext = {}): string {
  return records.map((r) => JSON.stringify(exportRow(r, ctx))).join('\n') + '\n';
}

/** RFC 4180 CSV: time, level, source (merged views), message, then `columns`. */
export function recordsToCsv(
  records: readonly LogRecord[],
  columns: readonly string[],
  ctx: ExportContext = {},
): string {
  const header = ['time', 'level', ...(ctx.sourceLabel ? ['source'] : []), 'message', ...columns];
  const rows = records.map((record) => {
    const row = exportRow(record, ctx);
    return [
      row.time ?? '',
      row.level ?? '',
      ...(ctx.sourceLabel ? [row.source ?? ''] : []),
      row.message,
      ...columns.map((c) => row.fields[c] ?? ''),
    ];
  });
  return toCsv(header, rows);
}

/**
 * The object the detail pane pretty-prints: a JSON line's own object, else
 * `{time, level, source?, message, …fields}` with fields at the top level
 * (so a clicked path is exactly the filter key). Source fields (pod,
 * container, stream labels) come last. Continuation lines are shown
 * separately, not here.
 */
export function recordDetailObject(
  record: LogRecord,
  ctx: ExportContext = {},
): Record<string, unknown> {
  const parsed = parsedRecord(record);
  const source = ctx.sourceFields?.(record);
  if (parsed.json)
    return source ? { ...parsed.json, ...prefixed(source, parsed.json) } : parsed.json;
  const out: Record<string, unknown> = {};
  if (parsed.time !== null) out.time = new Date(parsed.time).toISOString();
  if (record.level) out.level = record.level;
  out.message = parsed.message || recordText(record).split('\n', 1)[0]!;
  for (const [k, v] of Object.entries(parsed.fields)) if (!(k in out)) out[k] = v;
  if (source) Object.assign(out, prefixed(source, out));
  return out;
}

/** Source fields not already present in `taken`. */
function prefixed(source: Record<string, string>, taken: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (!(k in taken)) out[k] = v;
  return out;
}
