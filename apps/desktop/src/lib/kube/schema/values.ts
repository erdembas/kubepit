import YAML from 'yaml';
import type { JsonSchema, OpenApiSchema } from '@/types';
import type { PathSegment } from './fields';
import { SchemaSet, type SchemaNode } from './openapi';
import { validateManifest, type SchemaIssue } from './validate';
import { parseDocuments, type ParsedDoc } from './yamlAst';

/**
 * Helm values against a chart's `values.schema.json`: the schema set the
 * values editor binds to (completion, hovers, markers) and the diagnostics
 * the deploy dialog counts. Helm validates the *merged* values (chart
 * defaults, then the user's), so a required field the defaults provide is
 * never reported missing. No schema, no binding; nothing here blocks.
 */

export interface ValuesSchema {
  set: SchemaSet;
  root: SchemaNode;
  /** Chart defaults (parsed `values.yaml`); `null` = unknown, required fields are not checked. */
  defaults: unknown;
}

export function valuesSchema(schema: JsonSchema, defaultsYaml: string | null): ValuesSchema {
  const set = SchemaSet.fromJsonSchema(schema as OpenApiSchema);
  let defaults: unknown = null;
  if (defaultsYaml !== null) {
    try {
      defaults = YAML.parse(defaultsYaml) ?? {};
    } catch {
      defaults = null;
    }
  }
  return { set, root: set.rootNode(), defaults };
}

function valueAt(data: unknown, path: readonly PathSegment[]): unknown {
  let current = data;
  for (const seg of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[seg];
  }
  return current;
}

/** Schema problems of a values document (first YAML document only). */
export function valuesIssues(
  text: string,
  schema: ValuesSchema,
  docs: readonly ParsedDoc[] = parseDocuments(text),
): SchemaIssue[] {
  const doc = docs[0];
  if (!doc || doc.errors.length || !doc.contents) return [];
  const defaults = schema.defaults;
  return validateManifest(schema.set, schema.root, doc.contents, {
    isMissing: (path, field) =>
      defaults !== null && valueAt(defaults, [...path, field]) === undefined,
  });
}
