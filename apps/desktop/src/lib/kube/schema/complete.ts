import type { ApiResourceInfo, OpenApiIndex } from '@/types';
import { fieldMarkdown, formatValue } from './describe';
import { propertiesOf, type FieldInfo } from './fields';
import {
  ANY_NODE,
  hasProperties,
  isArrayNode,
  isMapNode,
  isObjectNode,
  type SchemaNode,
  type SchemaSet,
} from './openapi';

/**
 * Editor-neutral completion items (the Monaco layer maps them onto its own
 * types). `insertText` uses snippet syntax; `\t` indents one level and
 * continuation lines inherit the line's indentation when inserted.
 */

export type SuggestionKind = 'property' | 'enum' | 'value' | 'kind' | 'apiVersion';

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  insertText: string;
  detail: string;
  documentation: string;
  sortText: string;
  deprecated: boolean;
  /** Open completion again after inserting (a nested mapping follows). */
  retrigger: boolean;
  /** Only for `kind`: an `apiVersion` line to add when the document has none. */
  apiVersion?: string;
}

/** Escape snippet syntax in literal text. */
export const snippetText = (text: string) => text.replace(/[\\$}]/g, '\\$&');
const choiceText = (text: string) => text.replace(/[\\$}|,]/g, '\\$&');

function choice(values: unknown[]): string {
  return `\${1|${values.map((v) => choiceText(formatValue(v))).join(',')}|}`;
}

function scalarEnum(node: SchemaNode): unknown[] | null {
  return node.enum?.filter((v) => v !== null && typeof v !== 'object') ?? null;
}

/** What to insert for a property, shaped by its type. */
function propertySnippet(set: SchemaSet, field: FieldInfo): { text: string; retrigger: boolean } {
  const name = snippetText(field.name);
  const node = field.node;
  const values = scalarEnum(node);
  if (values?.length) return { text: `${name}: ${choice(values)}`, retrigger: false };
  if (node.types.length === 1 && node.types[0] === 'boolean')
    return { text: `${name}: \${1|true,false|}`, retrigger: false };
  if (isArrayNode(node)) {
    const items = node.items ? set.node(node.items) : ANY_NODE;
    if (hasProperties(items)) {
      const first = propertiesOf(set, items).find((f) => f.required);
      return first
        ? { text: `${name}:\n\t- ${snippetText(first.name)}: $1\n\t  $0`, retrigger: false }
        : { text: `${name}:\n\t- $0`, retrigger: true };
    }
    return { text: `${name}:\n\t- $0`, retrigger: false };
  }
  if (isObjectNode(node) || isMapNode(node))
    return { text: `${name}:\n\t$0`, retrigger: hasProperties(node) };
  return { text: `${name}: $0`, retrigger: false };
}

/**
 * Property names of a mapping. `bare` inserts just the name (the key's
 * colon is already there).
 */
export function propertySuggestions(
  set: SchemaSet,
  container: SchemaNode,
  siblings: readonly string[],
  bare: boolean,
): Suggestion[] {
  const taken = new Set(siblings);
  return propertiesOf(set, container)
    .filter((f) => !taken.has(f.name))
    .map((field) => {
      const snippet = bare
        ? { text: snippetText(field.name), retrigger: false }
        : propertySnippet(set, field);
      // Required first, deprecated and status last.
      const rank = field.required ? 0 : field.deprecated || field.name === 'status' ? 2 : 1;
      return {
        label: field.name,
        kind: 'property' as const,
        insertText: snippet.text,
        detail: field.type,
        documentation: fieldMarkdown(field),
        sortText: `${rank}_${field.name}`,
        deprecated: field.deprecated,
        retrigger: snippet.retrigger,
      };
    });
}

/** Values of an enum or boolean field. */
export function valueSuggestions(node: SchemaNode): Suggestion[] {
  const values =
    scalarEnum(node) ??
    (node.types.length === 1 && node.types[0] === 'boolean' ? [true, false] : []);
  return values.map((value, i) => ({
    label: formatValue(value),
    kind: node.enum ? ('enum' as const) : ('value' as const),
    insertText: snippetText(formatValue(value)),
    detail: '',
    documentation: '',
    sortText: String(i).padStart(4, '0'),
    deprecated: false,
    retrigger: false,
  }));
}

/** `apiVersion` values: discovery plus every version the OpenAPI index lists. */
export function apiVersionSuggestions(
  resources: readonly ApiResourceInfo[],
  index: OpenApiIndex | null,
  kind: string | null,
): Suggestion[] {
  const kinds = new Map<string, Set<string>>();
  for (const r of resources) {
    const set = kinds.get(r.api_version) ?? new Set<string>();
    set.add(r.kind);
    kinds.set(r.api_version, set);
  }
  for (const gv of index?.group_versions ?? [])
    if (!kinds.has(gv.api_version)) kinds.set(gv.api_version, new Set());
  return [...kinds.entries()].map(([apiVersion, served]) => {
    const serves = !!kind && served.has(kind);
    return {
      label: apiVersion,
      kind: 'apiVersion' as const,
      insertText: snippetText(apiVersion),
      detail: serves ? kind! : '',
      documentation: '',
      sortText: `${serves ? 0 : kind ? 2 : 1}_${apiVersion.includes('/') ? 1 : 0}_${apiVersion}`,
      deprecated: false,
      retrigger: false,
    };
  });
}

/** `kind` values of the cluster, narrowed to `apiVersion` when it serves any. */
export function kindSuggestions(
  resources: readonly ApiResourceInfo[],
  apiVersion: string | null,
): Suggestion[] {
  const matching = apiVersion ? resources.filter((r) => r.api_version === apiVersion) : [];
  const list = matching.length ? matching : resources;
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const r of list) {
    const key = `${r.api_version}/${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: r.kind,
      kind: 'kind',
      insertText: snippetText(r.kind),
      detail: r.api_version,
      documentation: '',
      sortText: `${r.group ? 1 : 0}_${r.kind}_${r.api_version}`,
      deprecated: false,
      retrigger: false,
      apiVersion: apiVersion ? undefined : r.api_version,
    });
  }
  return out;
}

/** Top-level keys before the document names its kind. */
export function headerSuggestions(siblings: readonly string[]): Suggestion[] {
  return ['apiVersion', 'kind', 'metadata']
    .filter((key) => !siblings.includes(key))
    .map((key, i) => ({
      label: key,
      kind: 'property' as const,
      insertText: key === 'metadata' ? 'metadata:\n\tname: $0' : `${key}: $0`,
      detail: key === 'metadata' ? 'ObjectMeta' : 'string',
      documentation: '',
      sortText: `0_${i}`,
      deprecated: false,
      retrigger: key !== 'metadata',
    }));
}
