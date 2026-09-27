import { isValidElement, type ReactNode } from 'react';
import type { KubeObject } from '@/types';
import { Chips, ConditionWords, Dash, RefLink, UsageBar } from './cells';
import type { ColumnContext, ColumnDef } from './types';

/**
 * Plain values of table cells for exports. A column may declare `text` /
 * `value`; otherwise the text is read from the element tree its `cell`
 * returns — without rendering it: strings and numbers are collected, the
 * shared cell components of `./cells` contribute what they display (all
 * chips, not just the first two), icons and dots contribute nothing.
 */

type TextOf = (props: never) => string;

const KNOWN = new Map<unknown, TextOf>([
  [Dash, () => ''],
  [Chips, (p: { values: string[] }) => p.values.join(', ')],
  [
    ConditionWords,
    (p: { chips: Array<{ label: string }> }) => p.chips.map((c) => c.label).join(', '),
  ],
  [
    RefLink,
    (p: { label?: ReactNode; target: { name: string } }) =>
      p.label != null ? nodeText(p.label) : p.target.name,
  ],
  [UsageBar, (p: { label: string }) => p.label],
]);

/** An em dash is how cells say "nothing"; exports leave the field empty instead. */
const EMPTY = /^[—–-]?$/;

function parts(node: ReactNode): Array<{ text: string; element: boolean }> {
  if (Array.isArray(node)) return node.flatMap(parts);
  if (isValidElement(node)) return [{ text: nodeText(node), element: true }];
  return [{ text: nodeText(node), element: false }];
}

/** The text a React node displays (see module docs). */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'bigint') return String(node);
  if (Array.isArray(node)) {
    // JSX text next to expressions joins as is; separate elements are words.
    let out = '';
    let prevElement = false;
    for (const part of parts(node)) {
      if (!part.text) continue;
      if (out && (part.element || prevElement) && !/\s$/.test(out)) out += ' ';
      out += part.text;
      prevElement = part.element;
    }
    return out;
  }
  if (isValidElement(node)) {
    const known = KNOWN.get(node.type);
    if (known) return (known as (props: unknown) => string)(node.props);
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** CSV text of one cell. */
export function columnText(column: ColumnDef, obj: KubeObject, ctx: ColumnContext): string {
  const raw = column.text ? column.text(obj, ctx) : nodeText(column.cell(obj, ctx));
  const text = raw.replace(/\s+/g, ' ').trim();
  return EMPTY.test(text) ? '' : text;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** JSON value of one cell: the column's raw value, else its text (numbers parsed, empty = null). */
export function columnValue(column: ColumnDef, obj: KubeObject, ctx: ColumnContext): unknown {
  if (column.value) return column.value(obj, ctx) ?? null;
  const text = columnText(column, obj, ctx);
  if (!text) return null;
  return NUMBER.test(text) ? Number(text) : text;
}

/** Stable JSON key of a column: its id (CRD printer columns use their own name). */
export function columnKey(column: ColumnDef): string {
  return column.id.replace(/^pc\d+:/, '') || column.id;
}
