import * as i18n from '@/i18n/core';
import { isAlias, isMap, isPair, isScalar, isSeq, type Node } from 'yaml';
import type { PathSegment } from './fields';
import {
  ANY_NODE,
  acceptsAnyKey,
  isAny,
  typeLabel,
  type JsonType,
  type SchemaNode,
  type SchemaSet,
} from './openapi';

/**
 * Schema diagnostics for one parsed manifest: unknown fields, wrong types,
 * missing required fields, unsupported enum values and value constraints
 * (`minimum` / `maximum` and their exclusive forms, `minLength` /
 * `maxLength`, `pattern`, `minItems` / `maxItems`). Offsets are the
 * absolute source ranges of the parsed YAML. Advisory only — nothing here
 * blocks editing or applying; the API server (or helm) stays the authority.
 */

export type IssueSeverity = 'error' | 'warning';

export interface SchemaIssue {
  severity: IssueSeverity;
  message: string;
  start: number;
  end: number;
}

export interface ValidateOptions {
  /**
   * Whether an absent required field counts as missing. Helm values are
   * merged over the chart defaults, so a field the defaults provide is not
   * missing from the user's values. Default: always missing.
   */
  isMissing?: (path: PathSegment[], field: string) => boolean;
}

const patterns = new Map<string, RegExp | null>();

/** A schema `pattern` as a RegExp; `null` when JavaScript cannot compile it (never judged). */
function compilePattern(pattern: string): RegExp | null {
  let re = patterns.get(pattern);
  if (re !== undefined) return re;
  re = null;
  for (const flags of ['u', '']) {
    try {
      re = new RegExp(pattern, flags);
      break;
    } catch {
      /* try without unicode mode, else give up */
    }
  }
  patterns.set(pattern, re);
  return re;
}

/** Constraint violations of a scalar that already has an accepted type. */
function constraintIssue(node: SchemaNode, value: unknown): string | null {
  if (typeof value === 'number') {
    if (node.minimum !== null && value < node.minimum)
      return i18n.t('Must be at least {min}.', { min: node.minimum });
    if (node.exclusiveMinimum !== null && value <= node.exclusiveMinimum)
      return i18n.t('Must be greater than {min}.', { min: node.exclusiveMinimum });
    if (node.maximum !== null && value > node.maximum)
      return i18n.t('Must be at most {max}.', { max: node.maximum });
    if (node.exclusiveMaximum !== null && value >= node.exclusiveMaximum)
      return i18n.t('Must be less than {max}.', { max: node.exclusiveMaximum });
    return null;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (node.minLength !== null && length < node.minLength)
      return i18n.plural(
        'Must be at least {count} character long.',
        'Must be at least {count} characters long.',
        node.minLength,
      );
    if (node.maxLength !== null && length > node.maxLength)
      return i18n.plural(
        'Must be at most {count} character long.',
        'Must be at most {count} characters long.',
        node.maxLength,
      );
    const re = node.pattern ? compilePattern(node.pattern) : null;
    if (re && !re.test(value))
      return i18n.t('Does not match the pattern {pattern}.', { pattern: node.pattern ?? '' });
  }
  return null;
}

type YamlType = JsonType | 'null';

function yamlType(node: Node): YamlType | null {
  if (isMap(node)) return 'object';
  if (isSeq(node)) return 'array';
  if (!isScalar(node)) return null;
  const value = node.value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' || typeof value === 'bigint') {
    const source = (node as { source?: string }).source ?? String(value);
    return typeof value === 'bigint' || (Number.isInteger(value) && !/[.eE]/.test(source))
      ? 'integer'
      : 'number';
  }
  return 'string';
}

function accepts(node: SchemaNode, type: JsonType): boolean {
  if (node.types.length === 0) return true;
  if (node.types.includes(type)) return true;
  return type === 'integer' && node.types.includes('number');
}

const keyOf = (node: unknown): string | null =>
  isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number')
    ? String(node.value)
    : null;

const rangeOf = (node: Node | null | undefined): [number, number] | null =>
  node?.range ? [node.range[0], Math.max(node.range[1], node.range[0] + 1)] : null;

/**
 * A required field the server fills in when missing (CRD structural
 * defaults). Builtin schemas publish Go zero values (`""`, `0`, `{}`) as
 * defaults of required fields too; those are still required.
 */
function defaultsItself(node: SchemaNode): boolean {
  if (!node.hasDefault) return false;
  const value = node.default;
  if (value === '' || value === 0 || value === false || value === null) return false;
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return false;
  return true;
}

function display(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function validateManifest(
  set: SchemaSet,
  root: SchemaNode,
  contents: Node,
  options: ValidateOptions = {},
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const push = (severity: IssueSeverity, message: string, range: [number, number] | null) => {
    if (range) issues.push({ severity, message, start: range[0], end: range[1] });
  };

  const check = (
    value: Node | null,
    node: SchemaNode,
    keyRange: [number, number] | null,
    path: PathSegment[],
  ) => {
    if (!value || isAny(node) || isAlias(value)) return;
    const type = yamlType(value);
    if (type === null || type === 'null') return;
    if (!accepts(node, type)) {
      push(
        'error',
        i18n.t('Expected {expected}, got {actual}.', {
          expected: typeLabel(set, node),
          actual: type,
        }),
        rangeOf(value),
      );
      return;
    }
    if (isScalar(value)) {
      if (node.enum?.length && !node.enum.includes(value.value)) {
        push(
          'error',
          i18n.t('Unsupported value "{value}". Expected one of: {values}.', {
            value: display(value.value),
            values: node.enum.map(display).join(', '),
          }),
          rangeOf(value),
        );
        return;
      }
      const problem = constraintIssue(node, value.value);
      if (problem) push('error', problem, rangeOf(value));
      return;
    }
    if (isMap(value)) {
      const present = new Set<string>();
      let firstKey: [number, number] | null = null;
      for (const pair of value.items) {
        if (!isPair(pair)) continue;
        const key = keyOf(pair.key);
        if (key === null || key === '<<') continue;
        present.add(key);
        const kr = rangeOf(pair.key as Node);
        firstKey ??= kr;
        const child = node.properties[key];
        if (child) check(pair.value as Node | null, set.node(child), kr, [...path, key]);
        else if (node.additional)
          check(pair.value as Node | null, set.node(node.additional), kr, [...path, key]);
        else if (!acceptsAnyKey(node))
          push(
            'warning',
            node.refName
              ? i18n.t('Unknown field "{field}" in {type}.', { field: key, type: node.refName })
              : i18n.t('Unknown field "{field}".', { field: key }),
            kr,
          );
      }
      // Status is written by controllers; a manifest never has to fill it in.
      if (path[0] !== 'status') {
        for (const field of node.required) {
          if (present.has(field)) continue;
          if (options.isMissing && !options.isMissing(path, field)) continue;
          const child = node.properties[field];
          if (child && defaultsItself(set.node(child))) continue;
          push(
            'warning',
            i18n.t('Missing required field "{field}".', { field }),
            keyRange ?? firstKey ?? rangeOf(value),
          );
        }
      }
      return;
    }
    if (isSeq(value)) {
      const count = value.items.length;
      if (node.minItems !== null && count < node.minItems)
        push(
          'error',
          i18n.plural(
            'Needs at least {count} item.',
            'Needs at least {count} items.',
            node.minItems,
          ),
          rangeOf(value),
        );
      else if (node.maxItems !== null && count > node.maxItems)
        push(
          'error',
          i18n.plural(
            'Allows at most {count} item.',
            'Allows at most {count} items.',
            node.maxItems,
          ),
          rangeOf(value),
        );
      const items = node.items ? set.node(node.items) : ANY_NODE;
      value.items.forEach((item, i) => check(item as Node | null, items, null, [...path, i]));
    }
  };

  check(contents, root, null, []);
  return issues;
}
