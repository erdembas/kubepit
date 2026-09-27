import type { ColumnContext, ColumnDef } from '@/lib/kube/columns';
import { columnKey, columnText, columnValue } from '@/lib/kube/columns/export';
import { normalizeObject, toDiffYaml } from '@/lib/kube/normalize';
import type { Gvk, KubeObject } from '@/types';

/**
 * Table exports (pure): CSV (RFC 4180), JSON rows and multi-document YAML.
 * Cell values are never translated — they are whatever the cluster holds;
 * only the CSV header uses the column labels the user sees.
 */

export type ExportFormat = 'csv' | 'json' | 'yaml';

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  csv: 'csv',
  json: 'json',
  yaml: 'yaml',
};

export interface CsvOptions {
  /**
   * Excel-friendly output: a UTF-8 byte order mark so Excel detects the
   * encoding, and text that would start a formula (`=`, `+`, `-`, `@`) is
   * prefixed with `'` so opening the file never evaluates cluster data.
   */
  excel?: boolean;
}

const FORMULA = /^[=+\-@\t\r]/;
const NUMERIC = /^[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?$/i;

/** One RFC 4180 field: quoted when it holds a quote, comma, CR or LF. */
export function csvField(value: string, { excel = false }: CsvOptions = {}): string {
  let text = value;
  if (excel && FORMULA.test(text) && !NUMERIC.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 document: CRLF line breaks, a header record, optional BOM. */
export function toCsv(header: string[], rows: string[][], options: CsvOptions = {}): string {
  const line = (fields: string[]) => fields.map((f) => csvField(f, options)).join(',');
  const body = [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
  return options.excel ? `﻿${body}` : body;
}

/** CSV of `items` with the given columns (labels as header, cell text as values). */
export function tableCsv(
  columns: readonly ColumnDef[],
  items: readonly KubeObject[],
  ctx: ColumnContext,
  options: CsvOptions = {},
): string {
  return toCsv(
    columns.map((c) => c.label()),
    items.map((o) => columns.map((c) => columnText(c, o, ctx))),
    options,
  );
}

/** Row objects keyed by column id, holding raw values (`null` for empty cells). */
export function tableRows(
  columns: readonly ColumnDef[],
  items: readonly KubeObject[],
  ctx: ColumnContext,
): Array<Record<string, unknown>> {
  const keys = uniqueKeys(columns);
  return items.map((o) =>
    Object.fromEntries(columns.map((c, i) => [keys[i]!, columnValue(c, o, ctx)])),
  );
}

export function tableJson(
  columns: readonly ColumnDef[],
  items: readonly KubeObject[],
  ctx: ColumnContext,
): string {
  return `${JSON.stringify(tableRows(columns, items, ctx), null, 2)}\n`;
}

function uniqueKeys(columns: readonly ColumnDef[]): string[] {
  const seen = new Set<string>();
  return columns.map((c) => {
    let key = columnKey(c);
    if (seen.has(key)) key = c.id;
    seen.add(key);
    return key;
  });
}

export interface YamlOptions {
  /** Keep `.status`. */
  status: boolean;
  /**
   * Keep server-managed metadata (uid, resourceVersion, generation,
   * creationTimestamp, managedFields when present, last-applied annotation).
   * Off gives manifests that can be re-applied elsewhere.
   */
  serverFields: boolean;
}

/** `apiVersion` of a GVK (`apps/v1`, core `v1`). */
export function apiVersionOf(gvk: Pick<Gvk, 'group' | 'version'>): string {
  return gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
}

/** One object ready for YAML: type fields filled in, then cleaned per `options`. */
export function exportObject(
  obj: KubeObject,
  gvk: Pick<Gvk, 'group' | 'version' | 'kind'>,
  options: YamlOptions,
): Record<string, unknown> {
  const typed = {
    ...obj,
    apiVersion: obj.apiVersion || apiVersionOf(gvk),
    kind: obj.kind || gvk.kind,
  };
  if (!options.serverFields) return normalizeObject(typed, { keepStatus: options.status });
  const copy = structuredClone(typed) as Record<string, unknown>;
  if (!options.status) delete copy.status;
  return copy;
}

/** Multi-document YAML (`---` between documents). */
export function objectsYaml(
  items: readonly KubeObject[],
  gvk: Pick<Gvk, 'group' | 'version' | 'kind'>,
  options: YamlOptions,
): string {
  return items.map((o) => toDiffYaml(exportObject(o, gvk, options))).join('---\n');
}

/** `prod-eu_pods_20260927-1412.csv`: safe on every file system. */
export function exportFileName(
  parts: readonly string[],
  format: ExportFormat,
  now = new Date(),
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const safe = parts
    .map((p) =>
      p
        .trim()
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean);
  return `${[...safe, stamp].join('_')}.${EXPORT_EXTENSION[format]}`;
}
